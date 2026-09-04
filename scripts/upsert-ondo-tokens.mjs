import { loadLocalEnv } from './_env.mjs';
import { callCloudRun, cloudRunEnabled } from './_cloudrun.mjs';
import {
    CURRENCY_MINTS,
    ETF_MINTS,
    LST_MINTS,
    MAJORS_MINTS,
    METALS_MINTS,
    RWA_MINTS,
    STOCKS_MINTS,
} from '../packages/asset-registry/src/data/list-mints.ts';

function getFlag(name) {
    return process.argv.includes(`--${name}`);
}

function getArg(name, fallback) {
    const flag = `--${name}`;
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return fallback;
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(value);
}

function hasValidSymbol(symbol) {
    const trimmed = typeof symbol === 'string' ? symbol.trim() : '';
    if (!trimmed) return false;
    // Legacy placeholder from older Birdeye parsing.
    if (trimmed === '???') return false;
    return true;
}

function hasUsableName(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return false;
    if (trimmed.toLowerCase() === 'unknown') return false;
    return true;
}

function hasUsablePrice(price) {
    if (typeof price !== 'number') return false;
    if (!Number.isFinite(price)) return false;
    // Treat 0 as placeholder / missing.
    if (price <= 0) return false;
    return true;
}

function isOndoMintAddress(address) {
    return typeof address === 'string' && address.trim().toLowerCase().endsWith('ondo');
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

function getUniqueAddresses(addresses) {
    /** @type {string[]} */
    const uniqueAddresses = [];
    const seen = new Set();

    for (const address of addresses) {
        const trimmed = String(address ?? '').trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;

        seen.add(trimmed);
        uniqueAddresses.push(trimmed);
    }

    return uniqueAddresses;
}

function chunk(items, size) {
    /** @type {Array<typeof items>} */
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

function getCuratedListAddresses(listId) {
    const byListId = {
        majors: MAJORS_MINTS,
        lsts: LST_MINTS,
        currencies: CURRENCY_MINTS,
        rwas: RWA_MINTS,
        etfs: ETF_MINTS,
        metals: METALS_MINTS,
        stocks: STOCKS_MINTS,
    };
    const addresses = byListId[listId];
    if (!addresses) throw new Error(`Unknown curated list id: ${listId}`);
    return [...addresses];
}

async function getSearchTokensByAddresses(addresses) {
    /** @type {Array<{ address: string; token: any; hasMarket: boolean }>} */
    const rows = [];
    for (const c of chunk(addresses, 250)) {
        const page = await callCloudRun('assets', 'query', 'tokensGetSearchTokensByAddresses', { addresses: c });
        rows.push(...page);
    }
    return rows;
}

async function main() {

    await loadLocalEnv();

    if (!cloudRunEnabled('assets')) {
        throw new Error(
            'Cloud Run backend is not configured. Set TOKENS_CLOUDRUN_ENABLED=true (or TOKENS_CLOUDRUN_ASSETS_URL) and TOKENS_CLOUDRUN_AUTH_TOKEN.',
        );
    }

    // Default to the Stocks tab; Ondo mints are filtered below unless overridden.
    const listId = getArg('list-id', 'stocks');

    const offset = parseNonNegativeInt(getArg('offset', '0'), 0);
    const limitRaw = getArg('limit', null);
    const warmChunkSize = Math.min(Math.max(toInt(getArg('warm-chunk-size', '50'), 50), 1), 250);
    const delayMs = Math.max(0, toInt(getArg('delay-ms', '200'), 200));

    const dryRun = getFlag('dry-run');
    const force = getFlag('force');
    const includeNonOndo = getFlag('include-non-ondo');

    const listAddressesRaw = getCuratedListAddresses(listId);
    let listAddresses = getUniqueAddresses(listAddressesRaw);

    // By default, keep this script scoped to Ondo mints (addresses ending in "ondo").
    if (!includeNonOndo) {
        listAddresses = listAddresses.filter(isOndoMintAddress);
    }

    if (listAddresses.length === 0) {
        throw new Error(`No addresses found for listId="${listId}" in list-mints.ts`);
    }

    const limit = Math.min(parsePositiveInt(limitRaw ?? String(listAddresses.length), listAddresses.length), 5000);
    const slice = listAddresses.slice(offset, offset + limit);

    console.log(
        [
            'Upserting curated tokens via Cloud Run mint warm',
            `listId=${listId}`,
            `uniqueAddresses=${formatNumber(listAddresses.length)}`,
            `offset=${offset}`,
            `limit=${limit}`,
            `processing=${formatNumber(slice.length)}`,
            `warmChunkSize=${warmChunkSize}`,
            `delayMs=${delayMs}`,
            `dryRun=${dryRun}`,
            `force=${force}`,
            `includeNonOndo=${includeNonOndo}`,
        ].join(' | '),
    );

    // Determine which addresses actually need backfilling (skip tokens already present with market data).
    /** @type {string[]} */
    let addressesToBackfill = slice;

    if (!force) {
        const existingRows = await getSearchTokensByAddresses(slice);

        addressesToBackfill = existingRows
            .filter(row => {
                if (!row || typeof row !== 'object') return true;
                if (row.token === null) return true;
                if (row.hasMarket === false) return true;

                // Refresh if we previously inserted placeholder metadata.
                const symbol = row.token?.symbol;
                const name = row.token?.name;
                const price = row.token?.price;
                if (!hasValidSymbol(symbol)) return true;
                if (!hasUsableName(name)) return true;
                if (!hasUsablePrice(price)) return true;

                return false;
            })
            .map(row => row.address)
            .filter(Boolean);
    }

    addressesToBackfill = getUniqueAddresses(addressesToBackfill);

    console.log(`backfillNeeded=${formatNumber(addressesToBackfill.length)}/${formatNumber(slice.length)}`);
    if (addressesToBackfill.length === 0) {
        console.log('Nothing to do.');
        return;
    }

    if (dryRun) {
        console.log(`dry-run addresses sample: ${addressesToBackfill.slice(0, 10).join(', ')}`);
        return;
    }

    // The assets service fetches Birdeye overviews server-side and upserts
    // token metadata + markets (replaces the old client-side Birdeye loop
    // against Convex `tokens.upsertFromBirdeye`).
    const warmChunks = chunk(addressesToBackfill, warmChunkSize);
    for (let i = 0; i < warmChunks.length; i++) {
        const mints = warmChunks[i];
        const result = await callCloudRun('assets', 'mutation', 'cacheWarmRequestMintsWarm', {
            mints,
            variantMarket: true,
            markets: true,
            minAgeMs: 0,
        });

        console.log(
            [
                `warm=${i + 1}/${warmChunks.length}`,
                `mints=${mints.length}`,
                `scheduled=${(result.scheduled ?? []).join(',') || '(none)'}`,
                `skipped=${(result.skipped ?? []).join(',') || '(none)'}`,
            ].join(' | '),
        );

        await sleep(delayMs);
    }

    console.log('\nDone scheduling.');

    // Verify DB has tokens now.
    const refreshed = await getSearchTokensByAddresses(slice);

    const present = refreshed.filter(r => r.token !== null).length;
    const withMarket = refreshed.filter(r => r.token !== null && r.hasMarket).length;

    console.log('\nVerification.');
    console.log(`presentInDb=${formatNumber(present)}/${formatNumber(slice.length)}`);
    console.log(`withMarketData=${formatNumber(withMarket)}/${formatNumber(slice.length)}`);
    console.log('Note: warms are asynchronous; re-run with --dry-run later to re-check coverage.');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
