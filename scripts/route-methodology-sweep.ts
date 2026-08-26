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
    // The response must never contradict the probes it spent.
    if (meta.selectedVariants !== variants.length) {
        fail(`meta.selectedVariants ${String(meta.selectedVariants)} != variants.length ${variants.length}`);
    }
    if (status === 'no_eligible_variants' && variants.length > 0) {
        const anyParity = variants.some(variant => variant.parityBasis !== 'none');
        if (anyParity) {
            fail('no_eligible_variants despite parity variants being probed (expected insufficient_quotes)');
        }
    }
    // Selection starved by a decimals coverage failure is retryable, never
    // "cannot be routed".
    if (status === 'no_eligible_variants' && variants.length === 0) {
        const excluded = (meta.excludedVariants as Json[]) ?? [];
        if (excluded.some(entry2 => entry2.reason === 'missing_decimals')) {
            fail('no_eligible_variants despite missing_decimals exclusions (expected insufficient_quotes)');
        }
    }
    if (allocation) {
        const legs = (allocation.legs as Json[]) ?? [];
        const legSum = legs.reduce((sum, leg) => sum + Number(leg.amountUsd), 0);
        const target = Number(allocation.targetUsd);
        const unallocated = Number(allocation.unallocatedUsd);
        if (legSum + unallocated !== target)
            fail(`legs (${legSum}) + unallocated (${unallocated}) != target (${target})`);

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
        // B: a collapsed leg may only survive when the one-shot repair budget
        // was already spent.
        for (const leg of legs) {
            const delta = get(leg, 'verification.deltaBps') as number | null;
            const disclosed = allocation.repaired === true || warnings.includes(`collapse_unrepairable:${leg.mint}`);
            if (delta !== null && delta < collapseBps && !disclosed) {
                fail(`leg ${leg.symbol} collapsed ${delta}bps with no repair and no unrepairable disclosure`);
            }
        }
        if (allocation.repaired === true && !warnings.some(w => w.startsWith('plan_repaired:'))) {
            fail('repaired plan missing plan_repaired warning');
        }
        // P1: the totals must declare their basis, and a restricted basis
        // must be accompanied by its disclosure warning.
        const basis = get(allocation, 'edge.basis');
        if (basis !== 'independent_quotes' && basis !== 'restricted_requotes') {
            fail(`edge.basis missing or invalid: ${String(basis)}`);
        }
        if (basis === 'restricted_requotes' && !warnings.includes('legs_restricted_requoted')) {
            fail('restricted_requotes basis without legs_restricted_requoted warning');
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
        // A: the gate is median-anchored, so each survivor sits within
        // parityGateBps of the MEDIAN — two survivors on opposite sides can
        // legitimately span up to ~2x the gate pairwise. That is the bound.
        const peg = allocation.pegSpreadBps as number | null;
        if (peg !== null && peg > 2 * parityGateBps) {
            fail(`surviving pegSpreadBps ${peg} exceeds 2x the published ${parityGateBps}bps median gate`);
        }
        // #1: share stability must agree with the legs and its warning.
        const stability = allocation.shareStability as string | undefined;
        const legConfidences = legs.map(leg => leg.shareConfidence as string);
        if (!stability || !['firm', 'mixed', 'soft'].includes(stability)) {
            fail(`shareStability missing or invalid: ${String(stability)}`);
        } else {
            const softCount = legConfidences.filter(c => c === 'soft').length;
            const expected = softCount === 0 ? 'firm' : softCount === legs.length ? 'soft' : 'mixed';
            if (stability !== expected) fail(`shareStability ${stability} disagrees with legs (${expected})`);
            if ((stability !== 'firm') !== warnings.includes('shares_may_move')) {
                fail(`shares_may_move warning disagrees with shareStability ${stability}`);
            }
        }
        // An RFQ-filled leg's offer has no persistence guarantee; its size
        // must never read firm.
        for (const leg of legs) {
            if (leg.router === 'jupiterz' && leg.shareConfidence === 'firm') {
                fail(`leg ${leg.symbol} is firm on an RFQ fill`);
            }
        }
        // #3: every plan declares its blended impact, and extreme values warn.
        const blended = allocation.blendedImpactBps as number | null | undefined;
        if (blended === undefined) {
            fail('allocation missing blendedImpactBps');
        } else if (blended !== null && blended > 150 !== warnings.includes('extreme_impact')) {
            fail(`extreme_impact warning disagrees with blendedImpactBps ${blended} (gate: >150bps = poor)`);
        }
        const grade = allocation.blendedImpactGrade as string | null | undefined;
        if (blended !== null && grade === undefined) fail('allocation missing blendedImpactGrade');
    }

    // --- Per-asset expectations ---
    if (entry.assetId === 'bitcoin') {
        if (status !== 'ok') fail(`expected ok, got ${status}`);
        const legs = (allocation?.legs as Json[]) ?? [];
        // Small orders legitimately fill on one variant; the split-regression
        // guard only applies at institutional size, and depth exhaustion
        // (unallocated remainder) legitimately concentrates what's left.
        if (
            entry.amountUsd >= 1_000_000 &&
            allocation &&
            legs.length < 2 &&
            allocation.fellBackToSingleVariant !== true &&
            Number(allocation.unallocatedUsd) === 0
        ) {
            fail('expected a multi-leg plan, a fallback, or a depth-exhaustion remainder');
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
            // A parity variant with quotes must produce a plan. (For an asset
            // whose only variant is parityBasis 'none', like silver's ETF
            // wrapper, no_eligible_variants IS the honest outcome.)
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

type SweepMode = 'baseline' | 'check' | 'stability';

interface SweepArgs {
    mode: SweepMode;
    outDir: string;
    /** stability mode: how many times to repeat the same request. */
    pings: number;
    gapSeconds: number;
    assetId: string;
    amountUsd: number;
}

function parseArgs(): SweepArgs {
    const args = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    const mode = (flag('--mode') ?? 'baseline') as SweepMode;
    if (mode !== 'baseline' && mode !== 'check' && mode !== 'stability') {
        console.error(`Unknown --mode ${mode}; expected baseline, check, or stability`);
        process.exit(2);
    }
    return {
        mode,
        outDir: flag('--out') ?? `/tmp/route-sweep-${mode}`,
        pings: Number(flag('--pings') ?? 5),
        gapSeconds: Number(flag('--gap-seconds') ?? 20),
        assetId: flag('--asset') ?? 'bitcoin',
        amountUsd: Number(flag('--amount') ?? 1_000_000),
    };
}

function stats(values: number[]): { mean: number; stdev: number; min: number; max: number } {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
    return { mean, stdev: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}

/** Repeat one request N times and report how much the plan moves. */
async function runStability(baseUrl: string, apiKey: string, args: SweepArgs, outDir: string): Promise<void> {
    const url = `${baseUrl}/api/v2/execution/route?assetId=${args.assetId}&amountUsd=${args.amountUsd}`;
    const shares = new Map<string, number[]>();
    const edges: number[] = [];
    const blended: number[] = [];
    const deltas: number[] = [];
    const stabilityLabels: string[] = [];

    console.log(
        `\nstability: ${args.assetId} @ $${args.amountUsd.toLocaleString('en-US')} x${args.pings} pings, ${args.gapSeconds}s apart\n`,
    );
    for (let ping = 1; ping <= args.pings; ping += 1) {
        const response = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
        const body = (await response.json()) as Json;
        writeFileSync(join(outDir, `ping-${ping}.json`), JSON.stringify(body, null, 2));
        const allocation = (body.allocation as Json | null) ?? null;
        if (!response.ok || !allocation) {
            console.log(`  ping ${ping}: ${response.status} ${String(body.allocationStatus ?? '')}`);
        } else {
            const legs = (allocation.legs as Json[]) ?? [];
            for (const leg of legs) {
                const list = shares.get(leg.symbol as string) ?? [];
                list.push(Number(leg.amountUsd));
                shares.set(leg.symbol as string, list);
            }
            const edge = get(allocation, 'edge.vsBestSingleVariant.bps') as number | undefined;
            if (typeof edge === 'number') edges.push(edge);
            if (typeof allocation.blendedImpactBps === 'number') blended.push(allocation.blendedImpactBps);
            for (const leg of legs) {
                const delta = get(leg, 'verification.deltaBps') as number | null;
                if (typeof delta === 'number') deltas.push(delta);
            }
            stabilityLabels.push(String(allocation.shareStability ?? '?'));
            const summary = legs
                .map(
                    leg =>
                        `${leg.symbol}:${Math.round(Number(leg.amountUsd) / 1000)}k(${String(leg.shareConfidence).charAt(0)})`,
                )
                .join(' / ');
            console.log(
                `  ping ${ping}: ${summary} | edge=${edge ?? 'null'}bps blended=${String(allocation.blendedImpactBps)} stability=${String(allocation.shareStability)}`,
            );
        }
        if (ping < args.pings) await new Promise(resolve => setTimeout(resolve, args.gapSeconds * 1_000));
    }

    console.log('\n  per-leg share movement:');
    for (const [symbol, values] of shares) {
        const s = stats(values);
        console.log(
            `    ${symbol.padEnd(8)} n=${values.length} mean $${Math.round(s.mean / 1000)}k stdev $${Math.round(s.stdev / 1000)}k range $${Math.round((s.max - s.min) / 1000)}k`,
        );
    }
    if (edges.length > 1) {
        const s = stats(edges);
        console.log(`  edge   : mean ${s.mean.toFixed(2)}bps stdev ${s.stdev.toFixed(2)} range ${s.min}-${s.max}`);
    }
    if (blended.length > 1) {
        const s = stats(blended);
        console.log(`  blended: mean ${s.mean.toFixed(2)}bps stdev ${s.stdev.toFixed(2)} range ${s.min}-${s.max}`);
    }
    if (deltas.length > 0) {
        const s = stats(deltas);
        const negatives = deltas.filter(value => value < 0);
        console.log(
            `  verify deltas: n=${deltas.length} mean ${s.mean.toFixed(2)}bps stdev ${s.stdev.toFixed(2)} min ${s.min} max ${s.max} negatives=${negatives.length}`,
        );
    }
    console.log(`  stability labels: ${stabilityLabels.join(', ')}`);
    console.log(`\nresponses saved to ${outDir}`);
}

async function main(): Promise<void> {
    const baseUrl = process.env.API_BASE_URL?.replace(/\/+$/, '');
    const apiKey = process.env.API_KEY;
    if (!baseUrl || !apiKey) {
        console.error('API_BASE_URL and API_KEY are required');
        process.exit(2);
    }
    const parsed = parseArgs();
    const { mode, outDir } = parsed;
    mkdirSync(outDir, { recursive: true });

    if (mode === 'stability') {
        await runStability(baseUrl, apiKey, parsed, outDir);
        return;
    }

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

    // Exit-liquidity coverage: one evaluate sell entry (~$1M of cbBTC).
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
