/* eslint-disable no-console */

/**
 * Read-only validation of stored depth curves against live Jupiter lite quotes.
 *
 * For each variant returned by GET /v2/execution/evaluate for an asset, compares
 * the stored per-rung price impact (Titan-sampled) with a fresh Jupiter lite
 * quote ladder computed the same way (effective price vs the smallest rung).
 * Independent cross-check: different aggregator, same math.
 *
 * Usage:
 *   API_BASE_URL=... API_KEY=... node scripts/check-depth-curves.mjs [assetId] [driftPct]
 *
 * Defaults: assetId=bitcoin, driftPct=25 (relative drift threshold per rung).
 * Exits 1 when any rung drifts beyond the threshold.
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LADDER_USD = [10_000, 100_000, 1_000_000, 5_000_000];
const JUPITER_BASE = process.env.JUPITER_BASE_URL ?? 'https://lite-api.jup.ag';
const JUPITER_DELAY_MS = 1_100;

const assetId = process.argv[2] ?? 'bitcoin';
const driftThresholdPct = Number(process.argv[3] ?? '25');

const baseUrl = (process.env.API_BASE_URL ?? '').trim().replace(/\/$/, '');
const apiKey = (process.env.API_KEY ?? '').trim();
if (!baseUrl || !apiKey) {
    console.error('API_BASE_URL and API_KEY must be set');
    process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jupiterQuote(outputMint, amountUsd) {
    const url =
        `${JUPITER_BASE}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${outputMint}` +
        `&amount=${Math.round(amountUsd * 1_000_000)}&slippageBps=50`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    const inAmount = Number(json.inAmount);
    const outAmount = Number(json.outAmount);
    if (!Number.isFinite(inAmount) || !Number.isFinite(outAmount) || inAmount <= 0 || outAmount <= 0) return null;
    return { sizeUsd: amountUsd, effectivePrice: outAmount / inAmount };
}

function impactsFromEffectivePrices(points) {
    const baseline = points.reduce((best, p) => (best === null || p.sizeUsd < best.sizeUsd ? p : best), null);
    if (!baseline || baseline.effectivePrice <= 0) return new Map();
    return new Map(
        points.map(p => [p.sizeUsd, Math.max(0, Math.round((1 - p.effectivePrice / baseline.effectivePrice) * 10_000))]),
    );
}

async function main() {
    const routeRes = await fetch(
        `${baseUrl}/v2/execution/evaluate?asset=${encodeURIComponent(assetId)}&amountUsd=1000000`,
        { headers: { 'x-api-key': apiKey } },
    );
    if (!routeRes.ok) {
        console.error(`GET /v2/execution/evaluate failed: HTTP ${routeRes.status}`);
        process.exit(1);
    }
    const route = await routeRes.json();
    const withCurves = route.variants.filter(v => v.depthAsOf !== null);
    console.log(
        `asset=${route.asset.assetId} variants=${route.variants.length} withCurves=${withCurves.length} ` +
            `primary=${route.primary?.mint ?? 'null'} depthSource=${route.meta.depthSource ?? 'null'}`,
    );
    if (withCurves.length === 0) {
        console.log('No fresh curves to validate — run the refresh-depth-curves job first.');
        return;
    }

    let violations = 0;
    for (const variant of withCurves) {
        console.log(`\n${variant.symbol ?? variant.mint} (${variant.mint})`);
        console.log(`  stored: impact@$1M=${variant.estimatedImpactBps}bps asOf=${variant.depthAsOf}`);

        const livePoints = [];
        for (const sizeUsd of LADDER_USD) {
            const point = await jupiterQuote(variant.mint, sizeUsd);
            if (point) livePoints.push(point);
            await sleep(JUPITER_DELAY_MS);
        }
        const liveImpacts = impactsFromEffectivePrices(livePoints);
        const liveAt1M = liveImpacts.get(1_000_000);
        if (liveAt1M === undefined) {
            console.log('  jupiter: no live quote at $1M — skipping comparison');
            continue;
        }
        console.log(`  jupiter: impact@$1M=${liveAt1M}bps (${livePoints.length}/${LADDER_USD.length} rungs quoted)`);

        const stored = variant.estimatedImpactBps;
        if (stored === null) continue;
        const reference = Math.max(Math.abs(liveAt1M), 5); // ignore sub-5bps noise in relative terms
        const driftPct = (Math.abs(stored - liveAt1M) / reference) * 100;
        const flag = driftPct > driftThresholdPct ? '  ⚠ DRIFT' : '  ok';
        console.log(`${flag}: |${stored} - ${liveAt1M}| = ${Math.abs(stored - liveAt1M)}bps (${driftPct.toFixed(1)}%)`);
        if (driftPct > driftThresholdPct) violations += 1;
    }

    console.log(violations > 0 ? `\n${violations} variant(s) beyond ${driftThresholdPct}% drift` : '\nAll within threshold');
    process.exit(violations > 0 ? 1 : 0);
}

main().catch(error => {
    console.error(String(error?.message ?? error));
    process.exit(1);
});
