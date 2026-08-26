/**
 * Routing-methodology sweep for GET /v2/execution/route.
 *
 * Runs a fixed ten-asset panel against a live stack and either snapshots the
 * behavior (--mode baseline) or grades it against structural expectations
 * (--mode check). The expectations are invariants, never exact numbers — live
 * quotes are nondeterministic, so "edge == +53bps" would flake while "no
 * negative-edge split ships" cannot.
 *
 *   API_BASE_URL=http://localhost:3002 API_KEY=... \
 *     bun run sweep:execution-route --mode check [--out /tmp/route-sweep-check]
 *
 * Cost: ~350 upstream quotes per run. A deliberate-analysis tool — never CI.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface PanelEntry {
    assetId: string;
    amountUsd: number;
}

/** The panel is fixed so before/after runs compare like for like. */
const PANEL: PanelEntry[] = [
    { assetId: 'bitcoin', amountUsd: 10_000 },
    { assetId: 'bitcoin', amountUsd: 1_000_000 },
    { assetId: 'bitcoin', amountUsd: 5_000_000 },
    { assetId: 'bitcoin', amountUsd: 25_000_000 },
    { assetId: 'ethereum', amountUsd: 1_000_000 },
    { assetId: 'hyperliquid', amountUsd: 1_000_000 },
    { assetId: 'tesla', amountUsd: 1_000_000 },
    { assetId: 'apple', amountUsd: 1_000_000 },
    { assetId: 'spacex', amountUsd: 1_000_000 },
    { assetId: 'micron', amountUsd: 50_000 },
    { assetId: 'micron', amountUsd: 1_000_000 },
    { assetId: 'gold', amountUsd: 1_000_000 },
    { assetId: 'silver', amountUsd: 1_000_000 },
    { assetId: 'usd', amountUsd: 1_000_000 },
];

/** Assets whose registry entry has exactly one variant (degenerate routing). */
const SINGLE_VARIANT_ASSETS = new Set(['ethereum', 'hyperliquid', 'silver']);
/** Assets where verification collapses were observed (thin equity books). */
const COLLAPSE_PRONE_ASSETS = new Set(['tesla', 'micron', 'apple']);

/** Fallbacks only — responses publish their resolved gates in meta.tuning. */
const FALLBACK_PARITY_GATE_BPS = 500;
const FALLBACK_COLLAPSE_BPS = -500;

type Json = Record<string, unknown>;

function get(obj: unknown, path: string): unknown {
    let current: unknown = obj;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Json)[key];
    }
    return current;
}

interface SweepRow {
    key: string;
    status: string;
    selected: number;
    legs: string;
    edgeBps: number | null;
    pegBps: number | null;
    unallocatedUsd: number | null;
    warnings: string[];
    violations: string[];
}

function summarizeLegs(allocation: Json | null): string {
    if (!allocation) return '—';
    const legs = (allocation.legs as Json[]) ?? [];
    return legs
        .map(leg => {
            const verification = leg.verification as Json;
            const delta = verification.deltaBps;
            const marker = verification.status === 'verified' ? `v${delta ?? ''}` : 'i';
            return `${leg.symbol} $${Math.round(Number(leg.amountUsd) / 1000)}k(${marker})`;
        })
        .join(' / ');
}

/**
 * Structural expectations for one response. Returns violation strings; empty
 * means the formula behaved. Weather tolerance: when no variant produced a
 * single successful rung, the market (or an upstream) is down — expectations
 * downgrade to "the response is honest about it".
 */
function checkExpectations(entry: PanelEntry, body: Json): string[] {
    const violations: string[] = [];
    const fail = (message: string) => violations.push(`${entry.assetId}@$${entry.amountUsd}: ${message}`);

    const variants = (body.variants as Json[]) ?? [];
    const meta = body.meta as Json;
    const warnings = (meta.warnings as string[]) ?? [];
    // Judge each response against the gates it says it ran under.
    const tuning = (meta.tuning as Json | undefined) ?? {};
    const parityGateBps = (tuning.parityDivergenceMaxBps as number) ?? FALLBACK_PARITY_GATE_BPS;
    const collapseBps = (tuning.collapseThresholdBps as number) ?? FALLBACK_COLLAPSE_BPS;
    const allocation = (body.allocation as Json | null) ?? null;
    const status = body.allocationStatus as string;

    const anySuccessfulRung = variants.some(variant =>
        ((get(variant, 'curve.rungs') as Json[]) ?? []).some(rung => rung.impactBps !== null),
    );
    if (!anySuccessfulRung) {
        // Upstream weather: nothing quoted anywhere. Honesty is the only bar.
        if (status === 'ok') fail('no variant quoted anything yet allocationStatus is ok');
        return violations;
    }

    // --- Universal invariants ---
    if (allocation) {
        const legs = (allocation.legs as Json[]) ?? [];
        const legSum = legs.reduce((sum, leg) => sum + Number(leg.amountUsd), 0);
        const target = Number(allocation.targetUsd);
        const unallocated = Number(allocation.unallocatedUsd);
        if (legSum + unallocated !== target) fail(`legs (${legSum}) + unallocated (${unallocated}) != target (${target})`);

        // E: no dust legs unless cap-bound.
        const floorUsd = Math.ceil(target / 100);
        for (const leg of legs) {
            const amount = Number(leg.amountUsd);
            if (amount >= floorUsd) continue;
            const variant = variants.find(v => v.mint === leg.mint);
            const cap = get(variant, 'curve.maxProvenSizeUsd') as number | null;
            if (cap !== amount) fail(`dust leg ${leg.symbol} $${amount} below 1% floor and not cap-bound (cap ${cap})`);
        }

        // B+C: a multi-leg plan must never ship losing to the best single variant.
        const edge = get(allocation, 'edge.vsBestSingleVariant') as Json | null;
        if (legs.length > 1 && edge && (edge.bps as number) < 0) {
            fail(`multi-leg plan shipped with negative edge ${edge.bps}bps`);
        }
        // B: no surviving collapsed leg.
        for (const leg of legs) {
            const delta = get(leg, 'verification.deltaBps') as number | null;
            if (delta !== null && delta < collapseBps) {
                fail(`leg ${leg.symbol} survived with collapsed verification ${delta}bps`);
            }
        }
        if (allocation.repaired === true && !warnings.some(w => w.startsWith('plan_repaired:'))) {
            fail('repaired plan missing plan_repaired warning');
        }
        // P0: leg overlap must be disclosed, and the field must agree with
        // the warning.
        const independence = allocation.legIndependence as Json | undefined;
        if (independence) {
            const overlapping =
                ((independence.passThrough as unknown[]) ?? []).length > 0 ||
                ((independence.sharedPools as unknown[]) ?? []).length > 0;
            if (overlapping !== !(independence.independent as boolean)) {
                fail('legIndependence.independent disagrees with its own evidence');
            }
            if (overlapping && !warnings.includes('legs_share_liquidity')) {
                fail('overlapping legs without legs_share_liquidity warning');
            }
        } else if (legs.length > 0) {
            fail('allocation missing legIndependence');
        }
        // A: surviving peg spread must be within the divergence gate.
        const peg = allocation.pegSpreadBps as number | null;
        if (peg !== null && peg > parityGateBps) {
            fail(`surviving pegSpreadBps ${peg} exceeds the published ${parityGateBps}bps divergence gate`);
        }
    }

    // --- Per-asset expectations ---
    if (entry.assetId === 'bitcoin') {
        if (status !== 'ok') fail(`expected ok, got ${status}`);
        const legs = (allocation?.legs as Json[]) ?? [];
        // Small orders legitimately fill on one variant; the split-regression
        // guard only applies at institutional size.
        if (entry.amountUsd >= 1_000_000 && allocation && legs.length < 2 && allocation.fellBackToSingleVariant !== true) {
            fail('expected a multi-leg plan or an explicit single-variant fallback');
        }
    }
    if (SINGLE_VARIANT_ASSETS.has(entry.assetId)) {
        const anyParity = variants.some(variant => variant.parityBasis !== 'none');
        if (status === 'ok') {
            const legs = (allocation?.legs as Json[]) ?? [];
            if (legs.length !== 1) fail(`single-variant asset produced ${legs.length} legs`);
            if (get(allocation, 'edge.vsBestSingleVariant') !== null) {
                fail('single-variant plan must have null edge (D)');
            }
        } else if (anyParity) {
            // A parity variant with quotes must produce a plan; silver's only
            // variant is an ETF wrapper (parityBasis 'none'), so for it the
            // honest outcome IS no_eligible_variants — comparison shown,
            // nothing summed. The baseline plan assumed silver had a spot
            // variant; the registry says otherwise.
            fail(`single parity variant blocked from the pool (status ${status})`);
        } else if (status !== 'no_eligible_variants') {
            fail(`all-derivative asset must report no_eligible_variants, got ${status}`);
        }
    }
    if (COLLAPSE_PRONE_ASSETS.has(entry.assetId) && allocation) {
        const edge = get(allocation, 'edge.vsBestSingleVariant') as Json | null;
        const legs = (allocation.legs as Json[]) ?? [];
        if (legs.length > 1 && edge && (edge.bps as number) < 0) {
            fail('collapse-prone asset shipped a losing split without repair/fallback (B+C)');
        }
    }
    if (entry.assetId === 'spacex' || entry.assetId === 'usd') {
        // A: allocated variants must not include a >gate divergence outlier.
        const allocatedMints = new Set(((allocation?.legs as Json[]) ?? []).map(leg => leg.mint as string));
        for (const variant of variants) {
            const divergence = get(variant, 'curve.parityDivergenceBps') as number | null | undefined;
            if (divergence != null && divergence > parityGateBps && allocatedMints.has(variant.mint as string)) {
                fail(`divergent variant ${variant.symbol} (${divergence}bps) received an allocation`);
            }
        }
    }
    if (entry.assetId === 'gold') {
        if (status !== 'ok') {
            fail(`gold expected ok after spot admission (A), got ${status}`);
        } else {
            for (const variant of variants) {
                if (variant.kind === 'etf' && variant.allocationEligible === true) {
                    fail(`etf variant ${variant.symbol} must not be allocation-eligible`);
                }
            }
            const legs = (allocation?.legs as Json[]) ?? [];
            const spotLeg = legs.some(leg => {
                const variant = variants.find(v => v.mint === leg.mint);
                return variant?.kind === 'spot';
            });
            if (allocation && !spotLeg) fail('gold plan has no spot-variant leg');
        }
    }

    return violations;
}

function parseArgs(): { mode: 'baseline' | 'check'; outDir: string } {
    const args = process.argv.slice(2);
    const modeIndex = args.indexOf('--mode');
    const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'baseline';
    if (mode !== 'baseline' && mode !== 'check') {
        console.error(`Unknown --mode ${mode}; expected baseline or check`);
        process.exit(2);
    }
    const outIndex = args.indexOf('--out');
    const outDir = outIndex >= 0 ? args[outIndex + 1]! : `/tmp/route-sweep-${mode}`;
    return { mode, outDir };
}

async function main(): Promise<void> {
    const baseUrl = process.env.API_BASE_URL?.replace(/\/+$/, '');
    const apiKey = process.env.API_KEY;
    if (!baseUrl || !apiKey) {
        console.error('API_BASE_URL and API_KEY are required');
        process.exit(2);
    }
    const { mode, outDir } = parseArgs();
    mkdirSync(outDir, { recursive: true });

    const rows: SweepRow[] = [];
    const allViolations: string[] = [];

    for (const entry of PANEL) {
        const key = `${entry.assetId}-${entry.amountUsd}`;
        const url = `${baseUrl}/api/v2/execution/route?assetId=${entry.assetId}&amountUsd=${entry.amountUsd}`;
        const response = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        const body = (await response.json()) as Json;
        writeFileSync(join(outDir, `${key}.json`), JSON.stringify(body, null, 2));

        if (!response.ok) {
            rows.push({
                key,
                status: `HTTP ${response.status}`,
                selected: 0,
                legs: '—',
                edgeBps: null,
                pegBps: null,
                unallocatedUsd: null,
                warnings: [String((body.error as Json | undefined)?.message ?? '')],
                violations: mode === 'check' ? [`${key}: HTTP ${response.status}`] : [],
            });
            if (mode === 'check') allViolations.push(`${key}: HTTP ${response.status}`);
            continue;
        }

        const allocation = (body.allocation as Json | null) ?? null;
        const violations = mode === 'check' ? checkExpectations(entry, body) : [];
        allViolations.push(...violations);
        rows.push({
            key,
            status: body.allocationStatus as string,
            selected: get(body, 'meta.selectedVariants') as number,
            legs: summarizeLegs(allocation),
            edgeBps: (get(allocation, 'edge.vsBestSingleVariant.bps') as number | undefined) ?? null,
            pegBps: (allocation?.pegSpreadBps as number | null) ?? null,
            unallocatedUsd: allocation ? Number(allocation.unallocatedUsd) : null,
            warnings: (get(body, 'meta.warnings') as string[]) ?? [],
            violations,
        });

        // Be kind to the per-provider limiters between panel entries.
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }

    console.log(`\nroute methodology sweep (${mode}) — ${new Date().toISOString()}\n`);
    for (const row of rows) {
        console.log(
            `${row.key.padEnd(20)} ${row.status.padEnd(22)} vars=${String(row.selected).padEnd(2)} ` +
                `edge=${row.edgeBps === null ? 'null' : `${row.edgeBps}bps`} peg=${row.pegBps ?? '—'} ` +
                `unalloc=${row.unallocatedUsd ?? '—'}`,
        );
        console.log(`${''.padEnd(21)}legs: ${row.legs}`);
        if (row.warnings.length > 0) console.log(`${''.padEnd(21)}warn: ${row.warnings.join(', ')}`);
        for (const violation of row.violations) console.log(`${''.padEnd(21)}✗ ${violation}`);
    }
    // Concurrency probe: two simultaneous /route calls exercise the
    // per-provider limiters under contention. Both must answer, neither 500s.
    {
        const probeUrl = `${baseUrl}/api/v2/execution/route?assetId=bitcoin&amountUsd=100000`;
        const startedAt = performance.now();
        const [first, second] = await Promise.all([
            fetch(probeUrl, { headers: { 'x-api-key': apiKey, accept: 'application/json' } }),
            fetch(probeUrl, { headers: { 'x-api-key': apiKey, accept: 'application/json' } }),
        ]);
        const elapsedMs = Math.round(performance.now() - startedAt);
        const concurrencyOk = first.status < 500 && second.status < 500 && elapsedMs < 30_000;
        console.log(
            `concurrency probe: ${first.status}/${second.status} in ${elapsedMs}ms ${concurrencyOk ? '' : '✗'}`,
        );
        if (mode === 'check' && !concurrencyOk) {
            allViolations.push(
                `concurrency: statuses ${first.status}/${second.status} in ${elapsedMs}ms (limit 30s, no 5xx)`,
            );
        }
    }

    // Exit-liquidity coverage: the /route panel is all buy-side, so one
    // evaluate sell entry keeps the sell path continuously tested. Fixed token
    // amount (~\$1M of cbBTC at 2026 prices); structural expectations only.
    const sellUrl =
        `${baseUrl}/api/v2/execution/evaluate?mint=cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij` +
        `&side=sell&tokenAmount=12`;
    const sellResponse = await fetch(sellUrl, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
    const sellBody = (await sellResponse.json()) as Json;
    writeFileSync(join(outDir, 'evaluate-sell-cbbtc.json'), JSON.stringify(sellBody, null, 2));
    if (mode === 'check') {
        if (!sellResponse.ok) {
            allViolations.push(`evaluate-sell: HTTP ${sellResponse.status}`);
        } else {
            const quotes = (sellBody.quotes as Json[]) ?? [];
            if (quotes.length !== 1) allViolations.push('evaluate-sell: expected exactly one row');
            const row = quotes[0];
            if (row && row.status !== 'available' && row.status !== 'unavailable') {
                allViolations.push('evaluate-sell: row has no valid status');
            }
        }
    }
    console.log(
        `evaluate-sell cbBTC x12: ${sellResponse.ok ? ((sellBody.quotes as Json[])?.[0]?.status ?? '?') : `HTTP ${sellResponse.status}`}`,
    );

    console.log(`\nresponses saved to ${outDir}`);

    if (mode === 'check') {
        if (allViolations.length > 0) {
            console.error(`\n${allViolations.length} expectation(s) violated:`);
            for (const violation of allViolations) console.error(`  ✗ ${violation}`);
            process.exit(1);
        }
        console.log('\nall structural expectations hold');
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
