/* eslint-disable no-console */

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function coerceBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/$/, '');
    assert(trimmed.length > 0, 'API_BASE_URL must be a non-empty string');

    const hasScheme = /^https?:\/\//i.test(trimmed);
    const withScheme = hasScheme
        ? trimmed
        : trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1')
          ? `http://${trimmed}`
          : `https://${trimmed}`;

    try {
        return new URL(withScheme).toString().replace(/\/$/, '');
    } catch {
        throw new Error(`API_BASE_URL is not a valid URL: ${value}`);
    }
}

function assertNotMintAssetId(assetId: unknown, path: string): asserts assetId is string {
    assert(typeof assetId === 'string', `${path} must be a string`);
    assert(!looksLikeSolanaMintAddress(assetId), `${path} must not be a raw mint address: ${assetId}`);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    assert(value !== null && typeof value === 'object', `${path} must be an object`);
}

function assertNullableNumber(value: unknown, path: string): void {
    if (value === null) return;
    assert(typeof value === 'number' && Number.isFinite(value), `${path} must be a finite number or null`);
}

function assertNullableString(value: unknown, path: string): void {
    if (value === null) return;
    assert(typeof value === 'string', `${path} must be a string or null`);
}

const ADVISORY_STATUSES = new Set(['caution', 'compromised', 'blocked']);
const ADVISORY_SOURCES = new Set(['admin', 'webacy_depeg']);

/** `advisory` must be present on every variant object: `null` or `{ status, reason, url, since }`. */
function assertVariantAdvisory(variant: Record<string, unknown>, path: string): string | null {
    assert('advisory' in variant, `${path}.advisory must exist (null allowed)`);
    const advisory = variant.advisory;
    if (advisory === null) return null;
    assertObject(advisory, `${path}.advisory`);
    assert(
        typeof advisory.status === 'string' && ADVISORY_STATUSES.has(advisory.status),
        `${path}.advisory.status must be one of caution|compromised|blocked`,
    );
    assert(typeof advisory.reason === 'string', `${path}.advisory.reason must be a string`);
    assertNullableString(advisory.url, `${path}.advisory.url`);
    assert(typeof advisory.since === 'number', `${path}.advisory.since must be a number`);
    if (advisory.source !== undefined) {
        assert(
            typeof advisory.source === 'string' && ADVISORY_SOURCES.has(advisory.source),
            `${path}.advisory.source must be one of admin|webacy_depeg when present`,
        );
    }
    return advisory.status;
}

/** `advisories` must be an array on every asset object (empty when nothing is flagged). */
function assertAssetAdvisories(asset: Record<string, unknown>, path: string): void {
    assert(Array.isArray(asset.advisories), `${path}.advisories must be an array`);
    for (let i = 0; i < asset.advisories.length; i++) {
        const entry = asset.advisories[i];
        assertObject(entry, `${path}.advisories[${i}]`);
        assert(typeof entry.mint === 'string', `${path}.advisories[${i}].mint must be a string`);
        assert(typeof entry.variantId === 'string', `${path}.advisories[${i}].variantId must be a string`);
        assertVariantAdvisory({ advisory: entry }, `${path}.advisories[${i}]`);
    }
}

/** List surfaces hide `blocked` mints; only detail/variants may serve them. */
function assertNotBlocked(status: string | null, path: string): void {
    assert(status !== 'blocked', `${path} must not surface a blocked variant on a list surface`);
}

function assertNoKeys(obj: Record<string, unknown>, forbiddenKeys: string[], path: string): void {
    for (const key of forbiddenKeys) {
        assert(!(key in obj), `${path} must not include \`${key}\``);
    }
}

function assertMarketSnapshot(market: unknown, path: string): void {
    if (market === null) return;
    assertObject(market, path);

    assertNullableNumber(market.price, `${path}.price`);
    assertNullableNumber(market.liquidity, `${path}.liquidity`);
    assertNullableNumber(market.volume24hUSD, `${path}.volume24hUSD`);
    assertNullableNumber(market.marketCap, `${path}.marketCap`);
    assertNullableNumber(market.priceChange24hPercent, `${path}.priceChange24hPercent`);
    assertNullableNumber(market.priceChange1hPercent, `${path}.priceChange1hPercent`);
    assertNullableNumber(market.decimals, `${path}.decimals`);
    assertNullableString(market.logoURI, `${path}.logoURI`);
    assertNullableNumber(market.lastFetchedAt, `${path}.lastFetchedAt`);
}

function assertStatsSnapshot(stats: unknown, path: string): void {
    if (stats === null) return;
    assertObject(stats, path);

    assertNullableNumber(stats.price, `${path}.price`);
    assertNullableNumber(stats.liquidity, `${path}.liquidity`);
    assertNullableNumber(stats.volume24hUSD, `${path}.volume24hUSD`);
    assertNullableNumber(stats.volume30dUSD, `${path}.volume30dUSD`);
    assertNullableNumber(stats.marketCap, `${path}.marketCap`);
    assertNullableNumber(stats.priceChange24hPercent, `${path}.priceChange24hPercent`);
    assertNullableNumber(stats.priceChange1hPercent, `${path}.priceChange1hPercent`);
}

function assertCanonicalMarketSnapshot(snapshot: unknown, path: string): void {
    if (snapshot === null || snapshot === undefined) return;
    assertObject(snapshot, path);

    assert(
        snapshot.source === 'coingecko' || snapshot.source === 'clickhouse_stock' || snapshot.source === 'prestocks',
        `${path}.source must be "coingecko", "clickhouse_stock", or "prestocks"`,
    );
    assertNullableNumber(snapshot.price, `${path}.price`);
    assertNullableNumber(snapshot.volume24hUSD, `${path}.volume24hUSD`);
    assertNullableNumber(snapshot.priceChange24hPercent, `${path}.priceChange24hPercent`);
    assertNullableNumber(snapshot.lastFetchedAt, `${path}.lastFetchedAt`);
    assertNullableNumber(snapshot.providerLastUpdatedAt, `${path}.providerLastUpdatedAt`);

    if (snapshot.source === 'coingecko') {
        assert(typeof snapshot.coinId === 'string', `${path}.coinId must be a string`);
        assertNullableNumber(snapshot.marketCap, `${path}.marketCap`);
    } else if (snapshot.source === 'prestocks') {
        assert(typeof snapshot.symbol === 'string', `${path}.symbol must be a string`);
        assert(typeof snapshot.mint === 'string', `${path}.mint must be a string`);
        assertNullableNumber(snapshot.marketCap, `${path}.marketCap`);
        assertNullableNumber(snapshot.markPriceUsd, `${path}.markPriceUsd`);
        assertNullableNumber(snapshot.markValuationUsd, `${path}.markValuationUsd`);
        assertNullableNumber(snapshot.impliedValuationUsd, `${path}.impliedValuationUsd`);
        assertNullableNumber(snapshot.premiumToMarkPercent, `${path}.premiumToMarkPercent`);
        assertNullableNumber(snapshot.asOf, `${path}.asOf`);
    } else {
        assert(typeof snapshot.symbol === 'string', `${path}.symbol must be a string`);
        assertNullableNumber(snapshot.asOf, `${path}.asOf`);
        if ('marketCap' in snapshot) assertNullableNumber(snapshot.marketCap, `${path}.marketCap`);
    }
}

async function fetchJson(baseUrl: string, path: string, apiKey: string): Promise<unknown> {
    const url = new URL(path, baseUrl);
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const text = await res.text();
    assert(res.ok, `Request failed (${res.status}) for ${url.toString()}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
}

async function verifySearch(baseUrl: string, apiKey: string, prefix: string, q: string): Promise<string[]> {
    const data = await fetchJson(baseUrl, `${prefix}/assets/search?q=${encodeURIComponent(q)}&limit=20`, apiKey);
    assertObject(data, 'search response');
    assert(typeof data.query === 'string', 'search.query must be a string');
    assert(Array.isArray(data.results), 'search.results must be an array');

    const assetIds: string[] = [];
    for (let i = 0; i < data.results.length; i++) {
        const row = data.results[i];
        assertObject(row, `search.results[${i}]`);
        assertNoKeys(row, ['aliases', 'symbols'], `search.results[${i}]`);
        const assetId = row.assetId;
        assertNotMintAssetId(assetId, `search.results[${i}].assetId`);
        assertStatsSnapshot(row.stats ?? null, `search.results[${i}].stats`);
        assertCanonicalMarketSnapshot(row.canonicalMarket, `search.results[${i}].canonicalMarket`);

        assertAssetAdvisories(row, `search.results[${i}]`);

        const primary = row.primaryVariant ?? null;
        if (primary !== null) {
            assertObject(primary, `search.results[${i}].primaryVariant`);
            assert('market' in primary, `search.results[${i}].primaryVariant.market must exist (null allowed)`);
            assertMarketSnapshot(primary.market ?? null, `search.results[${i}].primaryVariant.market`);
            assertNotBlocked(
                assertVariantAdvisory(primary, `search.results[${i}].primaryVariant`),
                `search.results[${i}].primaryVariant`,
            );
        }

        assetIds.push(assetId);
    }

    return assetIds;
}

async function verifyCurated(baseUrl: string, apiKey: string, prefix: string): Promise<string[]> {
    const data = await fetchJson(baseUrl, `${prefix}/assets/curated?list=majors&groupBy=asset`, apiKey);
    assertObject(data, 'curated response');
    assert(typeof data.listId === 'string', 'curated.listId must be a string');
    assert(Array.isArray(data.assets), 'curated.assets must be an array');

    const paginated = await fetchJson(baseUrl, `${prefix}/assets/curated?list=majors&groupBy=asset&limit=2`, apiKey);
    assertObject(paginated, 'paginated curated response');
    assertObject(paginated.pagination, 'paginated curated.pagination');
    assert(typeof paginated.pagination.offset === 'number', 'paginated curated.pagination.offset must be a number');
    assert(typeof paginated.pagination.limit === 'number', 'paginated curated.pagination.limit must be a number');
    assert(typeof paginated.pagination.total === 'number', 'paginated curated.pagination.total must be a number');
    assert(typeof paginated.pagination.hasMore === 'boolean', 'paginated curated.pagination.hasMore must be a boolean');
    assert(
        typeof paginated.pagination.nextOffset === 'number' || paginated.pagination.nextOffset === null,
        'paginated curated.pagination.nextOffset must be a number or null',
    );
    assert(Array.isArray(paginated.assets), 'paginated curated.assets must be an array');
    assert(
        paginated.assets.length <= paginated.pagination.limit,
        'paginated curated.assets length must be less than or equal to pagination.limit',
    );

    const assetIds: string[] = [];
    for (let i = 0; i < data.assets.length; i++) {
        const row = data.assets[i];
        assertObject(row, `curated.assets[${i}]`);
        assertNoKeys(row, ['aliases', 'symbols', 'variants'], `curated.assets[${i}]`);
        const assetId = row.assetId;
        assertNotMintAssetId(assetId, `curated.assets[${i}].assetId`);
        assertStatsSnapshot(row.stats ?? null, `curated.assets[${i}].stats`);
        assertCanonicalMarketSnapshot(row.canonicalMarket, `curated.assets[${i}].canonicalMarket`);

        assertAssetAdvisories(row, `curated.assets[${i}]`);

        const primary = row.primaryVariant ?? null;
        if (primary !== null) {
            assertObject(primary, `curated.assets[${i}].primaryVariant`);
            assert('market' in primary, `curated.assets[${i}].primaryVariant.market must exist (null allowed)`);
            assertMarketSnapshot(primary.market ?? null, `curated.assets[${i}].primaryVariant.market`);
            assertNotBlocked(
                assertVariantAdvisory(primary, `curated.assets[${i}].primaryVariant`),
                `curated.assets[${i}].primaryVariant`,
            );
        }

        assetIds.push(assetId);
    }

    const withVariants = await fetchJson(
        baseUrl,
        `${prefix}/assets/curated?list=majors&groupBy=asset&variants=all`,
        apiKey,
    );
    assertObject(withVariants, 'curated variants=all response');
    assert(Array.isArray(withVariants.assets), 'curated variants=all assets must be an array');
    for (let i = 0; i < withVariants.assets.length; i++) {
        const row = withVariants.assets[i];
        const path = `curated(variants=all).assets[${i}]`;
        assertObject(row, path);
        assertAssetAdvisories(row, path);
        assert(Array.isArray(row.variants), `${path}.variants must be an array`);
        for (let j = 0; j < row.variants.length; j++) {
            const variant = row.variants[j];
            assertObject(variant, `${path}.variants[${j}]`);
            assert(typeof variant.mint === 'string', `${path}.variants[${j}].mint must be a string`);
            assert('market' in variant, `${path}.variants[${j}].market must exist (null allowed)`);
            assertMarketSnapshot(variant.market ?? null, `${path}.variants[${j}].market`);
            assertNotBlocked(assertVariantAdvisory(variant, `${path}.variants[${j}]`), `${path}.variants[${j}]`);
        }
        const primary = row.primaryVariant ?? null;
        if (primary !== null) {
            assertObject(primary, `${path}.primaryVariant`);
            assertVariantAdvisory(primary, `${path}.primaryVariant`);
            assert(
                row.variants.some(
                    variant =>
                        typeof variant === 'object' &&
                        variant !== null &&
                        (variant as Record<string, unknown>).mint === primary.mint,
                ),
                `${path}.variants must include the primaryVariant mint`,
            );
        }
    }

    return assetIds;
}

async function verifyDetail(baseUrl: string, apiKey: string, prefix: string, assetId: string): Promise<void> {
    const data = await fetchJson(baseUrl, `${prefix}/assets/${encodeURIComponent(assetId)}`, apiKey);
    assertObject(data, 'detail response');
    assertObject(data.asset, 'detail.asset');
    assertNotMintAssetId(data.asset.assetId, 'detail.asset.assetId');
    assertCanonicalMarketSnapshot(
        (data.asset as Record<string, unknown>).canonicalMarket,
        'detail.asset.canonicalMarket',
    );

    // Market snapshot nullability invariants for the primary variant.
    const primary = (data.asset as Record<string, unknown>).primaryVariant ?? null;
    if (primary !== null) {
        assertObject(primary, 'detail.asset.primaryVariant');
        assert('market' in primary, 'detail.asset.primaryVariant.market must exist (null allowed)');
        assertMarketSnapshot((primary as Record<string, unknown>).market ?? null, 'detail.asset.primaryVariant.market');
        assertVariantAdvisory(primary, 'detail.asset.primaryVariant');
    }

    // Advisory invariants: `asset.advisories` always an array; every variant
    // group row carries `advisory` (detail keeps `blocked` visible — no
    // assertNotBlocked here).
    assertAssetAdvisories(data.asset, 'detail.asset');
    const variantGroups = (data.asset as Record<string, unknown>).variantGroups;
    if (variantGroups !== undefined) {
        assertObject(variantGroups, 'detail.asset.variantGroups');
        for (const [group, rows] of Object.entries(variantGroups)) {
            assert(Array.isArray(rows), `detail.asset.variantGroups.${group} must be an array`);
            for (let i = 0; i < rows.length; i++) {
                const variant = rows[i];
                assertObject(variant, `detail.asset.variantGroups.${group}[${i}]`);
                assertVariantAdvisory(variant, `detail.asset.variantGroups.${group}[${i}]`);
            }
        }
    }
}

/**
 * Optional: when a mint is known to be flagged (ADVISORY_MINT env), the detail
 * endpoint must still 200 with the advisory attached — never a 404 — and, if
 * the status is `blocked`, search must not surface it.
 */
async function verifyFlaggedMint(baseUrl: string, apiKey: string, prefix: string, mint: string): Promise<void> {
    const resolved = await verifyResolve(baseUrl, apiKey, prefix, mint);
    const data = await fetchJson(
        baseUrl,
        `${prefix}/assets/${encodeURIComponent(resolved)}?mint=${encodeURIComponent(mint)}`,
        apiKey,
    );
    assertObject(data, 'flagged detail response');
    assertObject(data.asset, 'flagged detail.asset');
    assertAssetAdvisories(data.asset, 'flagged detail.asset');
    const flagged = (data.asset.advisories as Array<Record<string, unknown>>).find(entry => entry.mint === mint);
    assert(flagged !== undefined, `flagged detail.asset.advisories must include ${mint}`);
    const primary = data.asset.primaryVariant;
    assertObject(primary, 'flagged detail.asset.primaryVariant');
    assert(primary.mint === mint, 'flagged detail must select the requested mint as primaryVariant');
    const status = assertVariantAdvisory(primary, 'flagged detail.asset.primaryVariant');
    assert(status !== null, 'flagged detail.asset.primaryVariant.advisory must be set');

    if (status === 'blocked') {
        const search = await fetchJson(baseUrl, `${prefix}/assets/search?q=${encodeURIComponent(mint)}&limit=20`, apiKey);
        assertObject(search, 'flagged search response');
        assert(Array.isArray(search.results), 'flagged search.results must be an array');
        for (const row of search.results) {
            assertObject(row, 'flagged search row');
            const rowPrimary = row.primaryVariant;
            if (rowPrimary && typeof rowPrimary === 'object') {
                assert(
                    (rowPrimary as Record<string, unknown>).mint !== mint,
                    'blocked mint must not appear as a search primaryVariant',
                );
            }
        }
    }
}

async function verifyDetailAssetId(
    baseUrl: string,
    apiKey: string,
    prefix: string,
    ref: string,
    expectedAssetId: string,
): Promise<void> {
    const data = await fetchJson(baseUrl, `${prefix}/assets/${encodeURIComponent(ref)}`, apiKey);
    assertObject(data, 'detail response');
    assertObject(data.asset, 'detail.asset');
    assert(
        (data.asset as Record<string, unknown>).assetId === expectedAssetId,
        `detail.asset.assetId for ${ref} must be ${expectedAssetId}`,
    );
    assertNotMintAssetId((data.asset as Record<string, unknown>).assetId, 'detail.asset.assetId');
}

async function verifyResolve(baseUrl: string, apiKey: string, prefix: string, ref: string): Promise<string> {
    const data = await fetchJson(baseUrl, `${prefix}/assets/resolve?ref=${encodeURIComponent(ref)}`, apiKey);
    assertObject(data, 'resolve response');
    assertNotMintAssetId(data.assetId, 'resolve.assetId');
    assertObject(data.asset, 'resolve.asset');
    assertNotMintAssetId((data.asset as Record<string, unknown>).assetId, 'resolve.asset.assetId');
    return data.assetId as string;
}

async function detectPrefix(baseUrl: string, apiKey: string): Promise<'api/v1' | 'v1'> {
    const candidates = ['api/v1', 'v1'] as const;
    const errors: string[] = [];

    for (const prefix of candidates) {
        try {
            await fetchJson(baseUrl, `${prefix}/assets/search?q=solana&limit=1`, apiKey);
            return prefix;
        } catch (err) {
            errors.push(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    throw new Error(`Failed to reach assets API via known prefixes:\n${errors.join('\n')}`);
}

async function main(): Promise<void> {
    const baseUrlRaw =
        process.env.API_BASE_URL?.trim() ??
        process.env.TOKENS_API_BASE_URL?.trim() ??
        process.env.TOKENS_API_ORIGIN?.trim() ??
        '';
    const apiKey = process.env.API_KEY?.trim() ?? process.env.TOKENS_API_KEY?.trim() ?? '';
    assert(baseUrlRaw.length > 0, 'Missing env: API_BASE_URL (example: http://localhost:3002)');
    assert(apiKey.length > 0, 'Missing env: API_KEY (or TOKENS_API_KEY)');

    const baseUrl = `${coerceBaseUrl(baseUrlRaw)}/`;
    const prefix = await detectPrefix(baseUrl, apiKey);

    const searched = await verifySearch(baseUrl, apiKey, prefix, 'solana');
    const curated = await verifyCurated(baseUrl, apiKey, prefix);

    // Check detail on a couple representative assets.
    for (const assetId of [...curated, ...searched].slice(0, 3)) {
        await verifyDetail(baseUrl, apiKey, prefix, assetId);
    }

    // Resolve invariants for a canonical mint.
    const wsolMint = 'So11111111111111111111111111111111111111112';
    const resolved = await verifyResolve(baseUrl, apiKey, prefix, wsolMint);
    await verifyDetail(baseUrl, apiKey, prefix, resolved);

    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const usdcSingletonRef = `solana-${usdcMint}`;
    const resolvedUsd = await verifyResolve(baseUrl, apiKey, prefix, usdcSingletonRef);
    assert(resolvedUsd === 'usd', `USDC singleton ref must resolve to usd, got ${resolvedUsd}`);
    await verifyDetailAssetId(baseUrl, apiKey, prefix, usdcSingletonRef, 'usd');

    const teslaXstockMint = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
    const resolvedTesla = await verifyResolve(baseUrl, apiKey, prefix, teslaXstockMint);
    assert(resolvedTesla === 'tesla', `Tesla xStock mint must resolve to tesla, got ${resolvedTesla}`);
    await verifyDetailAssetId(baseUrl, apiKey, prefix, teslaXstockMint, 'tesla');

    // PreStocks pre-IPO asset: the `anduril` alias must resolve, and any
    // canonicalMarket present must satisfy the union (including `prestocks`).
    const resolvedAnduril = await verifyResolve(baseUrl, apiKey, prefix, 'anduril');
    assert(
        resolvedAnduril.startsWith('pre-'),
        `anduril alias must resolve to a pre-* asset, got ${resolvedAnduril}`,
    );
    await verifyDetail(baseUrl, apiKey, prefix, resolvedAnduril);

    // Optional singleton mint check (for tokens outside a canonical asset).
    const singletonMint = process.env.SINGLETON_MINT?.trim() ?? '';
    if (singletonMint) {
        const singletonAssetId = await verifyResolve(baseUrl, apiKey, prefix, singletonMint);
        await verifyDetail(baseUrl, apiKey, prefix, singletonAssetId);
    }

    // Optional flagged-mint check (skipped when no fixture mint is flagged).
    const advisoryMint = process.env.ADVISORY_MINT?.trim() ?? '';
    if (advisoryMint) {
        await verifyFlaggedMint(baseUrl, apiKey, prefix, advisoryMint);
    }

    console.log('Assets API v1 contract verification passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
