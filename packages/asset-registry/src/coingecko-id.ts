/**
 * CoinGecko coin id an asset's reference market should be read under.
 *
 * `assets.coingecko_id` is written by the registry seed and by admin edits and
 * is not validated against CoinGecko, so a few known-wrong values are mapped
 * here before any price, metadata or derivation lookup. Every reader (API v1
 * and v2 routes, the worker's prefetch and v2 reads) goes through this one
 * function so they agree on which coin they fetch.
 */
export function normalizeCoinGeckoCoinIdForAsset(params: {
    assetId: string;
    coinId: string | null | undefined;
}): string | null {
    const rawCoinId = (params.coinId ?? '').trim();
    if (!rawCoinId) return null;

    const assetId = params.assetId.trim();

    // CoinGecko uses `binancecoin` (not `bnb`).
    if (assetId === 'bnb' && rawCoinId === 'bnb') return 'binancecoin';

    // `tron` is TRX (`tron`), not the xStock coin id (`tron-xstock`) that legacy
    // xStock grouping used to shadow the canonical crypto asset with.
    if (assetId === 'tron' && rawCoinId === 'tron-xstock') return 'tron';

    // Canonical `spacex` must never inherit the legacy PreStocks CoinGecko listing
    // (merged `spacex-prestocks` asset); its reference market comes from the
    // stock tables, with PreStocks remaining a variant.
    if (assetId === 'spacex' && rawCoinId === 'spacex-prestocks-2') return null;

    return rawCoinId;
}
