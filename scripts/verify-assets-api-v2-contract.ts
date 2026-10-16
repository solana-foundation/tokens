/* eslint-disable no-console */

/**
 * Live contract check for the v2 multichain asset surface: `/v2/chains`,
 * `/v2/assets`, `/v2/assets/{assetId}`, `/v2/assets/{assetId}/variants`,
 * `/v2/variants/{chain}/{address}` and the batch `/v2/variants?keys=`.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3002 API_KEY=... bun scripts/verify-assets-api-v2-contract.ts
 *   EXPECT_EVM=1 ...   # also require a Base USDC variant under `usd` (after the EVM jobs have run)
 *                      # and an executable-chain primary for `bitcoin` despite deeper EVM markets
 *   ALLOW_EMPTY_PEG=1 ... # skip the "some Solana `usd` variant has non-null pegHealth" check (no Webacy sync)
 *
 * Only exercises reads (assets:read). The design rules it pins: two nouns
 * (asset / variant), one key `<chain>:<address>` with lowercase EVM addresses,
 * all chains summed by default (`chain=` narrows what is listed, never what is
 * summed), no singleton ids, no v1 field names (`mint`, `variantGroups`,
 * `canonicalMarket`), and machine-readable `details.code` on every 4xx.
 */

const CHAIN_IDS = ['solana', 'ethereum', 'base', 'arbitrum', 'polygon', 'bnb'] as const;
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SYSTEM_PROGRAM = '11111111111111111111111111111111'; // base58-shaped, never a registered variant
const DEAD_EVM = '0x000000000000000000000000000000000000dead';
const FORBIDDEN_V1_KEYS = ['mint', 'variantGroups', 'canonicalMarket'] as const;
/** `GET /v2/assets/{assetId}?include=` values; each one lands on every variant in the response. */
const DETAIL_INCLUDES = ['executionQuality', 'pegHealth', 'preStocks'] as const;
const PRIMARY_POOLS = ['executable_active', 'active', 'executable', 'all'] as const;

function looksLikeSolanaAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function looksLikeLowercaseEvmAddress(value: string): boolean {
    return /^0x[0-9a-f]{40}$/.test(value);
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`);
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
    assert(Array.isArray(value), `${path} must be an array`);
}

function assertNullableString(value: unknown, path: string): void {
    if (value === null) return;
    assert(typeof value === 'string', `${path} must be a string or null`);
}

function assertNullableNumber(value: unknown, path: string): void {
    if (value === null) return;
    assert(typeof value === 'number' && Number.isFinite(value), `${path} must be a finite number or null`);
}

/** Deep-walks `value` and fails on any object key in `keys` — the v1 names v2 must never leak. */
function assertNoKeys(value: unknown, keys: readonly string[], path: string): void {
    if (Array.isArray(value)) {
        value.forEach((item, i) => assertNoKeys(item, keys, `${path}[${i}]`));
        return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assert(!keys.includes(key), `${path}.${key} is a v1-only field and must not appear in v2 payloads`);
        assertNoKeys(child, keys, `${path}.${key}`);
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys) && leftKeys.every(key => deepEqual(left[key], right[key]));
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

async function getJson(baseUrl: string, apiKey: string, path: string): Promise<unknown> {
    const res = await fetch(new URL(path, baseUrl), { headers: { 'x-api-key': apiKey } });
    const text = await res.text();
    assert(res.ok, `GET ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
}

/** Every 4xx on this surface carries a stable `details.code`; the message is not part of the contract. */
async function expectError(baseUrl: string, apiKey: string, path: string, status: number, code: string): Promise<void> {
    const res = await fetch(new URL(path, baseUrl), { headers: { 'x-api-key': apiKey } });
    assert(res.status === status, `GET ${path} must be HTTP ${status}, got ${res.status}`);
    const body: unknown = await res.json();
    assertObject(body, `error(${path})`);
    assertObject(body.error, `error(${path}).error`);
    assert(typeof body.error._tag === 'string', `error(${path}).error._tag must be a string`);
    assertObject(body.error.details, `error(${path}).error.details`);
    assert(body.error.details.code === code, `error(${path}).error.details.code must be '${code}', got ${String(body.error.details.code)}`);
}

// ---------------------------------------------------------------------------
// Shape assertions
// ---------------------------------------------------------------------------

function assertVariant(variant: unknown, path: string, options: { rankMustBeNull?: boolean } = {}): { key: string; chain: string; address: string } {
    assertObject(variant, path);
    assert(typeof variant.key === 'string' && variant.key.length > 0, `${path}.key must be a non-empty string`);
    assert(typeof variant.chain === 'string' && (CHAIN_IDS as readonly string[]).includes(variant.chain), `${path}.chain must be a known chain id`);
    assert(typeof variant.address === 'string' && variant.address.length > 0, `${path}.address must be a non-empty string`);
    assert(variant.key === `${variant.chain}:${variant.address}`, `${path}.key must equal '<chain>:<address>', got ${variant.key}`);
    if (variant.chain === 'solana') {
        assert(looksLikeSolanaAddress(variant.address), `${path}.address must be base58 on solana`);
    } else {
        assert(looksLikeLowercaseEvmAddress(variant.address), `${path}.address must be a lowercase 0x address on ${variant.chain}`);
    }
    assert(typeof variant.assetId === 'string' && variant.assetId.length > 0, `${path}.assetId must be a non-empty string`);
    assert(!looksLikeSolanaAddress(variant.assetId) && !variant.assetId.startsWith('solana-'), `${path}.assetId must not be a singleton id`);
    assert(typeof variant.variantId === 'string', `${path}.variantId must be a string`);
    assert(typeof variant.kind === 'string', `${path}.kind must be a string`);
    assert(
        variant.issuance === 'native' || variant.issuance === 'bridged' || variant.issuance === 'wrapped',
        `${path}.issuance must be native|bridged|wrapped`,
    );
    assertNullableString(variant.symbol, `${path}.symbol`);
    assertNullableString(variant.name, `${path}.name`);
    assertNullableString(variant.label, `${path}.label`);
    assertNullableNumber(variant.decimals, `${path}.decimals`);
    assertNullableString(variant.logoURI, `${path}.logoURI`);
    assert(typeof variant.liquidityTier === 'string', `${path}.liquidityTier must be a string`);
    assertArray(variant.tags, `${path}.tags`);
    assert('advisory' in variant, `${path}.advisory must exist (null allowed)`);
    if (variant.advisory !== null) {
        assertObject(variant.advisory, `${path}.advisory`);
        assert(typeof variant.advisory.status === 'string', `${path}.advisory.status must be a string`);
        assert(typeof variant.advisory.source === 'string', `${path}.advisory.source must be a string`);
        assert(variant.chain === 'solana', `${path}.advisory must be null off Solana (advisories are mint-keyed)`);
    }
    assert('rank' in variant, `${path}.rank must exist`);
    if (options.rankMustBeNull) {
        assert(variant.rank === null, `${path}.rank must be null in batch lookups`);
    } else {
        assert(typeof variant.rank === 'number', `${path}.rank must be a number when the asset's full set is loaded`);
    }
    assert(typeof variant.explorerUrl === 'string' && variant.explorerUrl.startsWith('https://'), `${path}.explorerUrl must be an https URL`);
    assert('market' in variant, `${path}.market must exist (null allowed)`);
    if (variant.market !== null) {
        assertObject(variant.market, `${path}.market`);
        assert(typeof variant.market.source === 'string', `${path}.market.source must be a string`);
        assertNullableNumber(variant.market.price, `${path}.market.price`);
        assertNullableNumber(variant.market.liquidity, `${path}.market.liquidity`);
    }
    return { key: variant.key, chain: variant.chain, address: variant.address };
}

/** Every variant surfaced by the detail route: `variants[]`, `primaryVariant` and each `primaryVariantByChain.*`. */
function detailVariants(asset: Record<string, unknown>, path: string): Array<{ path: string; variant: Record<string, unknown> }> {
    const out: Array<{ path: string; variant: Record<string, unknown> }> = [];
    assertArray(asset.variants, `${path}.variants`);
    for (const [i, variant] of asset.variants.entries()) {
        assertObject(variant, `${path}.variants[${i}]`);
        out.push({ path: `${path}.variants[${i}]`, variant });
    }
    if (asset.primaryVariant !== null) {
        assertObject(asset.primaryVariant, `${path}.primaryVariant`);
        out.push({ path: `${path}.primaryVariant`, variant: asset.primaryVariant });
    }
    assertObject(asset.primaryVariantByChain, `${path}.primaryVariantByChain`);
    for (const [chain, variant] of Object.entries(asset.primaryVariantByChain)) {
        assertObject(variant, `${path}.primaryVariantByChain.${chain}`);
        out.push({ path: `${path}.primaryVariantByChain.${chain}`, variant });
    }
    return out;
}

/** With `include=`, each requested key is on every variant: an object when there is data, `null` off-capability / without data. */
function assertEnrichment(variant: Record<string, unknown>, key: (typeof DETAIL_INCLUDES)[number], path: string): Record<string, unknown> | null {
    assert(key in variant, `${path}.${key} must exist when include=${key} was requested (null allowed)`);
    const value = variant[key];
    if (value === null) return null;
    assertObject(value, `${path}.${key}`);
    if (key === 'executionQuality') {
        assert(typeof value.quoteKey === 'string' && value.quoteKey.startsWith('solana:'), `${path}.executionQuality.quoteKey must be a solana:<mint> key`);
        assert(!('quoteMint' in value), `${path}.executionQuality.quoteMint is the v1 name; v2 uses quoteKey`);
        assert(typeof value.executionScore === 'number', `${path}.executionQuality.executionScore must be a number`);
        assert(typeof value.lastComputedAt === 'number', `${path}.executionQuality.lastComputedAt must be a number`);
    } else if (key === 'pegHealth') {
        assert(typeof value.provider === 'string', `${path}.pegHealth.provider must always be present`);
        assert(typeof value.referenceKind === 'string', `${path}.pegHealth.referenceKind must always be present`);
        assert(typeof value.tier === 'string', `${path}.pegHealth.tier must be a string`);
        assertNullableNumber(value.deviationPct, `${path}.pegHealth.deviationPct`);
        assert(typeof value.updatedAt === 'number', `${path}.pegHealth.updatedAt must be a number`);
        assert(typeof value.stale === 'boolean', `${path}.pegHealth.stale must be a boolean`);
    } else {
        assert(typeof value.symbol === 'string' && value.symbol.length > 0, `${path}.preStocks.symbol must be a non-empty string`);
        assertNullableNumber(value.markPriceUsd, `${path}.preStocks.markPriceUsd`);
        assertNullableNumber(value.markValuationUsd, `${path}.preStocks.markValuationUsd`);
        assertNullableNumber(value.impliedValuationUsd, `${path}.preStocks.impliedValuationUsd`);
        assertNullableNumber(value.premiumToMarkPercent, `${path}.preStocks.premiumToMarkPercent`);
        assert(typeof value.lastFetchedAt === 'number', `${path}.preStocks.lastFetchedAt must be a number`);
    }
    assert(variant.chain === 'solana', `${path}.${key} must be null off Solana (capability-gated data)`);
    return value;
}

function assertChainStats(stats: unknown, path: string): number {
    assertObject(stats, path);
    assertNullableNumber(stats.liquidity, `${path}.liquidity`);
    assertNullableNumber(stats.volume24hUSD, `${path}.volume24hUSD`);
    assertNullableNumber(stats.trade24h, `${path}.trade24h`);
    assertNullableNumber(stats.marketCap, `${path}.marketCap`);
    assert(typeof stats.variantCount === 'number' && stats.variantCount > 0, `${path}.variantCount must be a positive number`);
    assert(typeof stats.issuedVariantCount === 'number', `${path}.issuedVariantCount must be a number`);
    assert(stats.issuedVariantCount <= stats.variantCount, `${path}.issuedVariantCount must not exceed variantCount`);
    return stats.variantCount;
}

function assertAsset(asset: unknown, path: string, options: { expectVariants: boolean; listChain?: string | null }): Record<string, unknown> {
    assertObject(asset, path);
    assert(typeof asset.assetId === 'string' && asset.assetId.length > 0, `${path}.assetId must be a non-empty string`);
    assert(!looksLikeSolanaAddress(asset.assetId) && !asset.assetId.startsWith('solana-'), `${path}.assetId must not be a singleton id`);
    assertNullableString(asset.name, `${path}.name`);
    assertNullableString(asset.symbol, `${path}.symbol`);
    assert(typeof asset.category === 'string', `${path}.category must be a string`);
    assertArray(asset.aliases, `${path}.aliases`);
    assertArray(asset.symbols, `${path}.symbols`);
    assertNullableString(asset.imageUrl, `${path}.imageUrl`);

    // chains[] is exactly the set of keys in chainStats, in canonical order.
    assertArray(asset.chains, `${path}.chains`);
    assert(asset.chains.length > 0, `${path}.chains must be non-empty`);
    for (const chain of asset.chains) {
        assert(typeof chain === 'string' && (CHAIN_IDS as readonly string[]).includes(chain), `${path}.chains must only hold known chain ids`);
    }
    const canonicalOrder = CHAIN_IDS.filter(id => (asset.chains as string[]).includes(id));
    assert(deepEqual(asset.chains, canonicalOrder), `${path}.chains must be in canonical chain order`);
    assertObject(asset.chainStats, `${path}.chainStats`);
    const statKeys = Object.keys(asset.chainStats);
    assert(deepEqual([...statKeys].sort(), [...(asset.chains as string[])].sort()), `${path}.chainStats keys must equal chains[]`);
    let summedVariants = 0;
    for (const chain of statKeys) summedVariants += assertChainStats(asset.chainStats[chain], `${path}.chainStats.${chain}`);

    assertObject(asset.aggregate, `${path}.aggregate`);
    assert(asset.aggregate.variantCount === summedVariants, `${path}.aggregate.variantCount must equal the sum of chainStats variantCount`);
    assert(asset.aggregate.chainCount === statKeys.length, `${path}.aggregate.chainCount must equal the number of chains`);
    assert(typeof asset.aggregate.excludedFromSupplyCount === 'number', `${path}.aggregate.excludedFromSupplyCount must be a number`);

    assert('stats' in asset, `${path}.stats must exist (null allowed)`);
    if (asset.stats !== null) assertObject(asset.stats, `${path}.stats`);
    assert('referenceMarket' in asset, `${path}.referenceMarket must exist (null allowed)`);
    if (asset.referenceMarket !== null) {
        assertObject(asset.referenceMarket, `${path}.referenceMarket`);
        assert(
            asset.referenceMarket.source === 'coingecko' || asset.referenceMarket.source === 'stock' || asset.referenceMarket.source === 'prestocks',
            `${path}.referenceMarket.source must be coingecko|stock|prestocks`,
        );
    }
    assertArray(asset.advisories, `${path}.advisories`);
    for (const [i, advisory] of asset.advisories.entries()) {
        assertObject(advisory, `${path}.advisories[${i}]`);
        assert(typeof advisory.key === 'string' && advisory.key === `${String(advisory.chain)}:${String(advisory.address)}`, `${path}.advisories[${i}].key must be '<chain>:<address>'`);
    }
    assert(typeof asset.primaryVariantStrategy === 'string', `${path}.primaryVariantStrategy must be a string`);
    assert(asset.primaryScope === 'executable' || asset.primaryScope === 'global', `${path}.primaryScope must be executable or global`);
    assert('primaryVariantSelection' in asset, `${path}.primaryVariantSelection must exist (null allowed)`);
    if (asset.primaryVariantSelection !== null) {
        assertObject(asset.primaryVariantSelection, `${path}.primaryVariantSelection`);
        assert(
            (PRIMARY_POOLS as readonly unknown[]).includes(asset.primaryVariantSelection.pool),
            `${path}.primaryVariantSelection.pool must be one of ${PRIMARY_POOLS.join(', ')}`,
        );
        assertNullableString(asset.primaryVariantSelection.reason, `${path}.primaryVariantSelection.reason`);
    }
    assert((asset.primaryVariant === null) === (asset.primaryVariantSelection === null), `${path}.primaryVariantSelection must be null exactly when primaryVariant is`);
    assert('primaryVariant' in asset, `${path}.primaryVariant must exist`);
    if (asset.primaryVariant !== null) assertVariant(asset.primaryVariant, `${path}.primaryVariant`);
    assertObject(asset.primaryVariantByChain, `${path}.primaryVariantByChain`);
    for (const [chain, variant] of Object.entries(asset.primaryVariantByChain)) {
        assert((asset.chains as string[]).includes(chain), `${path}.primaryVariantByChain.${chain} must be one of chains[]`);
        const parsed = assertVariant(variant, `${path}.primaryVariantByChain.${chain}`);
        assert(parsed.chain === chain, `${path}.primaryVariantByChain.${chain} must be a variant on ${chain}`);
    }
    assert('rank' in asset, `${path}.rank must exist (null allowed)`);

    if (options.expectVariants) {
        assertArray(asset.variants, `${path}.variants`);
        assert(asset.variants.length > 0, `${path}.variants must be non-empty`);
        const seen = new Set<string>();
        for (const [i, variant] of asset.variants.entries()) {
            const parsed = assertVariant(variant, `${path}.variants[${i}]`);
            assert(!seen.has(parsed.key), `${path}.variants must not repeat a key (${parsed.key})`);
            seen.add(parsed.key);
            if (options.listChain) assert(parsed.chain === options.listChain, `${path}.variants[${i}] must be on ${options.listChain} when chain= is set`);
        }
    } else {
        assert(!('variants' in asset), `${path}.variants must be absent without include=variants`);
    }

    assertNoKeys(asset, FORBIDDEN_V1_KEYS, path);
    return asset;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function verifyChains(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/chains');
    assertObject(body, 'chains response');
    assertArray(body.chains, 'chains.chains');
    assert(body.total === body.chains.length, 'chains.total must equal chains.length');
    const ids = body.chains.map((chain, i) => {
        const path = `chains.chains[${i}]`;
        assertObject(chain, path);
        assert(typeof chain.id === 'string', `${path}.id must be a string`);
        assert(typeof chain.caip2 === 'string' && chain.caip2.includes(':'), `${path}.caip2 must be a CAIP-2 id`);
        assert(chain.family === 'svm' || chain.family === 'evm', `${path}.family must be svm|evm`);
        assert(chain.family === 'svm' ? chain.evmChainId === null : typeof chain.evmChainId === 'number', `${path}.evmChainId must match the family`);
        assert(typeof chain.label === 'string' && chain.label.length > 0, `${path}.label must be a non-empty string`);
        assertObject(chain.explorer, `${path}.explorer`);
        assert(typeof chain.explorer.tokenUrlTemplate === 'string' && chain.explorer.tokenUrlTemplate.includes('{address}'), `${path}.explorer.tokenUrlTemplate must contain {address}`);
        assertObject(chain.capabilities, `${path}.capabilities`);
        for (const flag of ['markets', 'dexMarkets', 'ohlcv', 'risk', 'executionQuality', 'swap', 'firstPartyLogos']) {
            assert(typeof chain.capabilities[flag] === 'boolean', `${path}.capabilities.${flag} must be a boolean`);
        }
        assertNullableNumber(chain.variantCount, `${path}.variantCount`);
        assertNullableNumber(chain.assetCount, `${path}.assetCount`);
        return chain.id;
    });
    assert(deepEqual(ids, [...CHAIN_IDS]), `chains must be exactly ${CHAIN_IDS.join(', ')} in order; got ${ids.join(', ')}`);
}

async function verifyAssetsList(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/assets?list=majors&limit=5&include=variants');
    assertObject(body, 'assets response');
    assert(body.list === 'majors', 'assets.list must echo the slug');
    assert(typeof body.total === 'number' && body.total > 0, 'assets.total must be a positive number');
    assert(typeof body.primaryVariantStrategy === 'string', 'assets.primaryVariantStrategy must be a string');
    assert(body.primaryScope === 'executable', 'assets.primaryScope must default to executable');
    assertArray(body.assets, 'assets.assets');
    assert(body.assets.length > 0 && body.assets.length <= 5, 'assets.assets must honour limit=5 and be non-empty');
    for (const [i, row] of body.assets.entries()) {
        const asset = assertAsset(row, `assets.assets[${i}]`, { expectVariants: true });
        assert(asset.primaryVariant !== null, `assets.assets[${i}].primaryVariant must be non-null on a curated list`);
        assert(asset.rank === i, `assets.assets[${i}].rank must be the 0-based list position`);
    }
    assertNoKeys(body, FORBIDDEN_V1_KEYS, 'assets');

    const bare = await getJson(baseUrl, apiKey, 'api/v2/assets?list=majors&limit=2');
    assertObject(bare, 'assets(no include)');
    assertArray(bare.assets, 'assets(no include).assets');
    for (const [i, row] of bare.assets.entries()) assertAsset(row, `assets(no include).assets[${i}]`, { expectVariants: false });
}

/** `chain=` narrows what is listed, never what is summed: aggregate and stats must match the unfiltered row. */
async function verifyChainFilterDoesNotChangeSums(baseUrl: string, apiKey: string): Promise<void> {
    const [filtered, unfiltered] = await Promise.all([
        getJson(baseUrl, apiKey, 'api/v2/assets?list=currencies&chain=solana&include=variants&limit=500'),
        getJson(baseUrl, apiKey, 'api/v2/assets?list=currencies&include=variants&limit=500'),
    ]);
    assertObject(filtered, 'assets(chain=solana)');
    assertObject(unfiltered, 'assets(unfiltered)');
    assertArray(filtered.assets, 'assets(chain=solana).assets');
    assertArray(unfiltered.assets, 'assets(unfiltered).assets');
    assert(filtered.assets.length > 0, 'currencies must have at least one asset with a Solana variant');
    assert(filtered.assets.length <= unfiltered.assets.length, 'chain= must never add assets');

    const byId = new Map<string, Record<string, unknown>>();
    for (const [i, row] of unfiltered.assets.entries()) {
        const asset = assertAsset(row, `assets(unfiltered).assets[${i}]`, { expectVariants: true });
        byId.set(asset.assetId as string, asset);
    }
    for (const [i, row] of filtered.assets.entries()) {
        const asset = assertAsset(row, `assets(chain=solana).assets[${i}]`, { expectVariants: true, listChain: 'solana' });
        assert((asset.chains as string[]).includes('solana'), `assets(chain=solana).assets[${i}].chains must include solana`);
        const full = byId.get(asset.assetId as string);
        assert(full, `assets(chain=solana).assets[${i}] (${String(asset.assetId)}) must also be in the unfiltered list`);
        assert(deepEqual(asset.aggregate, full.aggregate), `${String(asset.assetId)}: aggregate must not change with chain=solana`);
        assert(deepEqual(asset.chainStats, full.chainStats), `${String(asset.assetId)}: chainStats must not change with chain=solana`);
        assert(deepEqual(asset.chains, full.chains), `${String(asset.assetId)}: chains[] must not change with chain=solana`);
        assert(deepEqual(asset.stats, full.stats), `${String(asset.assetId)}: stats must not change with chain=solana`);
        const fullVariants = full.variants as unknown[];
        assert((asset.variants as unknown[]).length <= fullVariants.length, `${String(asset.assetId)}: chain=solana must list a subset of the variants`);
    }
}

/**
 * Primary selection: the default scope ranks executable chains (capabilities.swap) first;
 * primaryScope=global ranks every chain.
 */
async function verifyPrimarySelection(baseUrl: string, apiKey: string, expectEvm: boolean): Promise<void> {
    const chains = await getJson(baseUrl, apiKey, 'api/v2/chains');
    assertObject(chains, 'chains response');
    assertArray(chains.chains, 'chains.chains');
    const executable = new Set(
        chains.chains.flatMap(chain => {
            assertObject(chain, 'chains.chains[]');
            assertObject(chain.capabilities, 'chains.chains[].capabilities');
            return chain.capabilities.swap === true ? [String(chain.id)] : [];
        }),
    );
    assert(executable.size > 0, 'at least one chain must support swap');

    const body = await getJson(baseUrl, apiKey, 'api/v2/assets/bitcoin');
    const asset = assertAsset(body, 'asset(bitcoin)', { expectVariants: true });
    assert(asset.primaryScope === 'executable', 'asset(bitcoin).primaryScope must default to executable');
    assertObject(asset.primaryVariant, 'asset(bitcoin).primaryVariant');
    assertObject(asset.primaryVariantSelection, 'asset(bitcoin).primaryVariantSelection');
    const pool = asset.primaryVariantSelection.pool;
    if (pool === 'executable_active' || pool === 'executable') {
        assert(executable.has(String(asset.primaryVariant.chain)), `asset(bitcoin).primaryVariant must sit on a swap chain when pool=${String(pool)}`);
    }
    if (expectEvm) {
        assert((asset.chains as string[]).some(chain => !executable.has(chain)), 'EXPECT_EVM: asset(bitcoin) must span a non-executable chain');
        assert(pool === 'executable_active', `EXPECT_EVM: asset(bitcoin) primary must come from executable_active, got ${String(pool)}`);
    }

    const global = await getJson(baseUrl, apiKey, 'api/v2/assets/bitcoin?primaryScope=global');
    const globalAsset = assertAsset(global, 'asset(bitcoin, global)', { expectVariants: true });
    assert(globalAsset.primaryScope === 'global', 'asset(bitcoin, global).primaryScope must echo global');
    assertObject(globalAsset.primaryVariantSelection, 'asset(bitcoin, global).primaryVariantSelection');
    assert(
        globalAsset.primaryVariantSelection.pool === 'active' || globalAsset.primaryVariantSelection.pool === 'all',
        'asset(bitcoin, global).primaryVariantSelection.pool must be active or all',
    );
}

async function verifyAssetDetail(baseUrl: string, apiKey: string, expectEvm: boolean, allowEmptyPeg: boolean): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/assets/usd');
    const asset = assertAsset(body, 'asset(usd)', { expectVariants: true });
    assert(asset.assetId === 'usd', `asset(usd).assetId must be 'usd', got ${String(asset.assetId)}`);
    assert(asset.resolvedBy === 'assetId', `asset(usd).resolvedBy must be 'assetId', got ${String(asset.resolvedBy)}`);
    assert((asset.chains as string[]).includes('solana'), 'asset(usd).chains must include solana');
    assert(asset.stats !== null, 'asset(usd).stats must be non-null');
    // `usd` is an aggregate canonical (no CoinGecko id), so its reference market is null by design.
    assert(asset.referenceMarket === null || typeof asset.referenceMarket === 'object', 'asset(usd).referenceMarket must be null or an object');
    assert(asset.primaryVariant !== null, 'asset(usd).primaryVariant must be non-null');
    const keys = (asset.variants as unknown[]).map((variant, i) => assertVariant(variant, `asset(usd).variants[${i}]`).key);
    assert(keys.includes(`solana:${USDC_SOLANA}`), 'asset(usd).variants must include USDC on Solana');

    // Without include= none of the enrichment keys appear anywhere.
    for (const { path, variant } of detailVariants(asset, 'asset(usd)')) {
        for (const key of DETAIL_INCLUDES) assert(!(key in variant), `${path}.${key} must be absent without include=${key}`);
    }

    if (expectEvm) {
        assert((asset.chains as string[]).includes('base'), 'EXPECT_EVM: asset(usd).chains must include base');
        assertObject(asset.chainStats, 'asset(usd).chainStats');
        assert('base' in asset.chainStats, 'EXPECT_EVM: asset(usd).chainStats.base must exist');
        assert(keys.includes(`base:${USDC_BASE}`), 'EXPECT_EVM: asset(usd).variants must include USDC on Base (lowercase key)');
        assertObject(asset.primaryVariantByChain, 'asset(usd).primaryVariantByChain');
        assert('base' in asset.primaryVariantByChain, 'EXPECT_EVM: asset(usd).primaryVariantByChain.base must exist');
    }

    // include= puts every requested key on every variant; null off-capability (EVM) or without data.
    const enriched = await getJson(baseUrl, apiKey, `api/v2/assets/usd?include=${DETAIL_INCLUDES.join(',')}`);
    const enrichedAsset = assertAsset(enriched, 'asset(usd, include)', { expectVariants: true });
    assert(enrichedAsset.primaryVariant !== null, 'asset(usd, include).primaryVariant must be non-null');
    let solanaPegHealthSeen = false;
    let evmVariantsSeen = 0;
    for (const { path, variant } of detailVariants(enrichedAsset, 'asset(usd, include)')) {
        const values = Object.fromEntries(DETAIL_INCLUDES.map(key => [key, assertEnrichment(variant, key, path)]));
        if (variant.chain === 'solana') {
            if (values.pegHealth !== null) solanaPegHealthSeen = true;
        } else {
            evmVariantsSeen += 1;
            for (const key of DETAIL_INCLUDES) assert(values[key] === null, `${path}.${key} must be null on ${String(variant.chain)} (no capability)`);
        }
    }
    if (!allowEmptyPeg) {
        assert(solanaPegHealthSeen, 'asset(usd, include): at least one Solana variant must carry non-null pegHealth (usd is a stablecoin); set ALLOW_EMPTY_PEG=1 without the Webacy sync');
    }
    if (expectEvm) assert(evmVariantsSeen > 0, 'EXPECT_EVM: asset(usd, include) must surface at least one EVM variant to check null enrichments on');
    assertNoKeys(enriched, FORBIDDEN_V1_KEYS, 'asset(usd, include)');

    // Repeated params are accepted too and equal the comma form.
    const repeated = await getJson(baseUrl, apiKey, 'api/v2/assets/usd?include=pegHealth&include=preStocks');
    const repeatedAsset = assertAsset(repeated, 'asset(usd, include repeated)', { expectVariants: true });
    for (const { path, variant } of detailVariants(repeatedAsset, 'asset(usd, include repeated)')) {
        assertEnrichment(variant, 'pegHealth', path);
        assertEnrichment(variant, 'preStocks', path);
        assert(!('executionQuality' in variant), `${path}.executionQuality must be absent when not requested`);
    }

    // Aliases resolve and say so.
    const alias = await getJson(baseUrl, apiKey, 'api/v2/assets/usdc');
    assertObject(alias, 'asset(usdc)');
    assert(alias.assetId === 'usd', `asset(usdc) must resolve to 'usd', got ${String(alias.assetId)}`);
    assert(alias.resolvedBy === 'alias', `asset(usdc).resolvedBy must be 'alias', got ${String(alias.resolvedBy)}`);
}

async function verifyAssetVariants(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/assets/usd/variants?chain=solana&limit=3');
    assertObject(body, 'asset-variants(usd, solana)');
    assert(body.assetId === 'usd', 'asset-variants.assetId must be usd');
    assert(body.sort === 'liquidity', `asset-variants.sort must default to liquidity, got ${String(body.sort)}`);
    assertArray(body.variants, 'asset-variants.variants');
    assert(body.variants.length > 0 && body.variants.length <= 3, 'asset-variants must honour limit=3 and be non-empty');
    assert(typeof body.total === 'number' && body.total >= 3, `asset-variants.total must be >= 3, got ${String(body.total)}`);
    let previousLiquidity = Number.POSITIVE_INFINITY;
    for (const [i, variant] of body.variants.entries()) {
        const parsed = assertVariant(variant, `asset-variants.variants[${i}]`);
        assert(parsed.chain === 'solana', `asset-variants.variants[${i}] must be on solana`);
        assertObject(variant, `asset-variants.variants[${i}]`);
        const liquidity = variant.market !== null && typeof variant.market === 'object' ? ((variant.market as Record<string, unknown>).liquidity ?? 0) : 0;
        assert(typeof liquidity === 'number' && liquidity <= previousLiquidity, 'asset-variants must be sorted by liquidity descending');
        previousLiquidity = liquidity;
    }
    assertNoKeys(body, FORBIDDEN_V1_KEYS, 'asset-variants');
}

async function verifyVariantLookup(baseUrl: string, apiKey: string, expectEvm: boolean): Promise<void> {
    const body = await getJson(baseUrl, apiKey, `api/v2/variants/solana/${USDC_SOLANA}`);
    assertObject(body, 'variant(solana USDC)');
    const variant = assertVariant(body.variant, 'variant(solana USDC).variant');
    assert(variant.key === `solana:${USDC_SOLANA}`, `variant.key must be solana:${USDC_SOLANA}`);
    assertObject(body.asset, 'variant(solana USDC).asset');
    assert(body.asset.assetId === 'usd', `variant(solana USDC).asset.assetId must be 'usd', got ${String(body.asset.assetId)}`);
    assertArray(body.asset.chains, 'variant(solana USDC).asset.chains');
    assert(body.asset.chains.includes('solana'), 'variant(solana USDC).asset.chains must include solana');
    assert(!('variants' in body.asset) && !('chainStats' in body.asset), 'variant lookup must return an asset summary, not the full asset');
    assertNoKeys(body, FORBIDDEN_V1_KEYS, 'variant(solana USDC)');

    if (expectEvm) {
        // Any casing in, lowercase out.
        const checksummed = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const base = await getJson(baseUrl, apiKey, `api/v2/variants/base/${checksummed}`);
        assertObject(base, 'variant(base USDC)');
        const parsed = assertVariant(base.variant, 'variant(base USDC).variant');
        assert(parsed.key === `base:${USDC_BASE}`, `EXPECT_EVM: variant(base USDC).key must be lowercase base:${USDC_BASE}, got ${parsed.key}`);
        assertObject(base.asset, 'variant(base USDC).asset');
        assert(base.asset.assetId === 'usd', 'EXPECT_EVM: variant(base USDC) must belong to usd');
    }
}

async function verifyVariantsBatch(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, `api/v2/variants?keys=solana:${USDC_SOLANA},solana:${SYSTEM_PROGRAM}`);
    assertObject(body, 'variants batch');
    assertArray(body.variants, 'variants.variants');
    assertArray(body.missing, 'variants.missing');
    assert(body.total === body.variants.length, 'variants.total must equal variants.length');
    assert(body.variants.length === 1, `variants batch must return exactly the one registered key, got ${body.variants.length}`);
    const first = assertVariant(body.variants[0], 'variants.variants[0]', { rankMustBeNull: true });
    assert(first.key === `solana:${USDC_SOLANA}`, 'variants.variants[0] must be USDC in request order');
    assert(body.missing.length === 1, `variants.missing must hold the one unregistered key, got ${body.missing.length}`);
    assertObject(body.missing[0], 'variants.missing[0]');
    assert(body.missing[0].key === `solana:${SYSTEM_PROGRAM}`, 'variants.missing[0].key must be the unregistered key');
    assert(body.missing[0].chain === 'solana' && body.missing[0].address === SYSTEM_PROGRAM, 'variants.missing[0] must carry chain + address');
    assertNoKeys(body, FORBIDDEN_V1_KEYS, 'variants batch');

    // Request order is kept and duplicates collapse.
    const ordered = await getJson(baseUrl, apiKey, `api/v2/variants?keys=solana:${SYSTEM_PROGRAM},solana:${USDC_SOLANA},solana:${USDC_SOLANA}`);
    assertObject(ordered, 'variants batch (ordered)');
    assertArray(ordered.variants, 'variants(ordered).variants');
    assert(ordered.variants.length === 1, 'duplicate keys must collapse to one variant');
}

async function verifyErrors(baseUrl: string, apiKey: string): Promise<void> {
    // Address-shaped / key-shaped {assetId} is a 400, never a singleton lookup.
    await expectError(baseUrl, apiKey, `api/v2/assets/${encodeURIComponent(`solana:${USDC_SOLANA}`)}`, 400, 'invalid_asset_id');
    await expectError(baseUrl, apiKey, `api/v2/assets/${USDC_SOLANA}`, 400, 'invalid_asset_id');
    await expectError(baseUrl, apiKey, `api/v2/assets/${USDC_BASE}`, 400, 'invalid_asset_id');
    await expectError(baseUrl, apiKey, 'api/v2/assets/this-asset-does-not-exist', 404, 'asset_not_found');
    await expectError(baseUrl, apiKey, 'api/v2/assets/this-asset-does-not-exist/variants', 404, 'asset_not_found');

    await expectError(baseUrl, apiKey, `api/v2/variants/ethereum/${USDC_SOLANA}`, 400, 'invalid_address');
    await expectError(baseUrl, apiKey, `api/v2/variants/solana/${USDC_BASE}`, 400, 'invalid_address');
    await expectError(baseUrl, apiKey, `api/v2/variants/polygon-pos/${USDC_BASE}`, 400, 'invalid_chain');
    await expectError(baseUrl, apiKey, `api/v2/variants/base/${DEAD_EVM}`, 404, 'variant_not_found');

    await expectError(baseUrl, apiKey, 'api/v2/variants', 400, 'invalid_key');
    await expectError(baseUrl, apiKey, `api/v2/variants?keys=${USDC_SOLANA}`, 400, 'invalid_key');
    await expectError(baseUrl, apiKey, `api/v2/variants?keys=polygon-pos:${USDC_BASE}`, 400, 'invalid_chain');
    await expectError(baseUrl, apiKey, `api/v2/variants?keys=base:${USDC_SOLANA}`, 400, 'invalid_address');
    const tooMany = Array.from({ length: 51 }, (_, i) => `base:0x${i.toString(16).padStart(40, '0')}`).join(',');
    await expectError(baseUrl, apiKey, `api/v2/variants?keys=${tooMany}`, 400, 'too_many_keys');

    await expectError(baseUrl, apiKey, 'api/v2/assets?list=not-a-list', 400, 'invalid_list');
    await expectError(baseUrl, apiKey, 'api/v2/assets?chain=polygon-pos', 400, 'invalid_chain');
    await expectError(baseUrl, apiKey, 'api/v2/assets?category=nope', 400, 'invalid_category');
    await expectError(baseUrl, apiKey, 'api/v2/assets?include=risk', 400, 'invalid_include');
    await expectError(baseUrl, apiKey, 'api/v2/assets/usd?include=risk', 400, 'invalid_include');
    await expectError(baseUrl, apiKey, 'api/v2/assets?primaryVariantStrategy=nope', 400, 'invalid_primary_variant_strategy');
    await expectError(baseUrl, apiKey, 'api/v2/assets?primaryScope=nope', 400, 'invalid_primary_scope');
    await expectError(baseUrl, apiKey, 'api/v2/assets/bitcoin?primaryScope=nope', 400, 'invalid_primary_scope');
    await expectError(baseUrl, apiKey, `api/v2/assets?q=${'x'.repeat(101)}`, 400, 'invalid_query');
    await expectError(baseUrl, apiKey, 'api/v2/assets/usd/variants?sort=nope', 400, 'invalid_sort');
    await expectError(baseUrl, apiKey, 'api/v2/assets/usd/variants?kind=nope', 400, 'invalid_kind');
    await expectError(baseUrl, apiKey, 'api/v2/assets/usd/variants?liquidityTier=tier9', 400, 'invalid_liquidity_tier');
    await expectError(baseUrl, apiKey, 'api/v2/assets/usd/variants?stockVariantTier=nope', 400, 'invalid_stock_variant_tier');
}

/** The documented public path is a rewrite onto `/api/v2/*`; a 404 here means the rewrite is missing. */
async function verifyPublicPathRewrite(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, `v2/variants/solana/${USDC_SOLANA}`);
    assertObject(body, 'public-path variant response');
    assertObject(body.variant, 'public-path variant.variant');
    assert(body.variant.key === `solana:${USDC_SOLANA}`, '/v2/variants must serve the same handler as /api/v2/variants');
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
    const expectEvm = /^(1|true|yes)$/i.test(process.env.EXPECT_EVM ?? '');
    const allowEmptyPeg = /^(1|true|yes)$/i.test(process.env.ALLOW_EMPTY_PEG ?? '');

    const baseUrl = `${coerceBaseUrl(baseUrlRaw)}/`;

    await verifyChains(baseUrl, apiKey);
    await verifyAssetsList(baseUrl, apiKey);
    await verifyChainFilterDoesNotChangeSums(baseUrl, apiKey);
    await verifyAssetDetail(baseUrl, apiKey, expectEvm, allowEmptyPeg);
    await verifyPrimarySelection(baseUrl, apiKey, expectEvm);
    await verifyAssetVariants(baseUrl, apiKey);
    await verifyVariantLookup(baseUrl, apiKey, expectEvm);
    await verifyVariantsBatch(baseUrl, apiKey);
    await verifyErrors(baseUrl, apiKey);
    await verifyPublicPathRewrite(baseUrl, apiKey);

    console.log(`Multichain assets API v2 contract verification passed${expectEvm ? ' (EVM assertions included)' : ' (EVM assertions skipped; set EXPECT_EVM=1)'}.`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
