import { classifyLiquidityTier, liquidityTierPriority, normalizeLegacyTier } from '@tokens/asset-registry';

import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';
import type { VariantMarketRow } from './variantMarkets';

export type AssetVariantKind =
    | 'native'
    | 'wrapped'
    | 'bridged'
    | 'spot'
    | 'etf'
    | 'yield'
    | 'leveraged'
    | 'basket'
    | 'lst'
    | 'stablecoin'
    | 'tokenized_equity';

export type TrustTier = 'tier1' | 'tier2' | 'tier3';
export type StockVariantTier = 'share_redeemable' | 'cash_redeemable' | 'not_redeemable';
export type ChainKind = 'solana';

const ASSET_VARIANT_KINDS: readonly AssetVariantKind[] = [
    'native',
    'wrapped',
    'bridged',
    'spot',
    'etf',
    'yield',
    'leveraged',
    'basket',
    'lst',
    'stablecoin',
    'tokenized_equity',
];

const TRUST_TIERS: readonly TrustTier[] = ['tier1', 'tier2', 'tier3'];

const SOLANA_DEFAULT_VARIANTS_VIEW_KEY = 'solana:variants:default';

export interface AssetVariantDocRow {
    asset_id: string;
    chain: string;
    mint: string;
    variant_id: string;
    kind: string;
    trust_tier: string;
    stock_variant_tier: string | null;
    tags: string[];
    issuer: string | null;
    issuer_url: string | null;
    label: string | null;
    is_active: boolean;
    created_at: number;
    updated_at: number;
}

export interface AssetVariantsRepo {
    findVariantByMint(mint: string): Promise<AssetVariantDocRow | null>;
    findVariantsByMints(mints: readonly string[]): Promise<AssetVariantDocRow[]>;
    findVariantsByAssetIds(
        assetIds: readonly string[],
        includeInactive: boolean,
    ): Promise<AssetVariantDocRow[]>;
    findActiveSolanaVariants(): Promise<AssetVariantDocRow[]>;
    findAssetIsActive(assetId: string): Promise<boolean | null>;
    findSolanaDefaultVariantsView(): Promise<{ variants_json: string; updated_at: number } | null>;
    upsertSolanaDefaultVariantsView(args: {
        variantsJson: string;
        updatedAt: number;
    }): Promise<void>;
    findVariantMarketsByMints(mints: readonly string[]): Promise<VariantMarketRow[]>;
    findTokenMarketsByMints(mints: readonly string[]): Promise<TokenMarketRow[]>;
}

export interface TokenMarketRow {
    mint: string;
    source: string;
    markets: unknown;
    total: number;
    last_fetched_at: number;
}

export interface AssetVariantResult {
    assetId: string;
    chain: ChainKind;
    mint: string;
    variantId: string;
    kind: AssetVariantKind;
    trustTier: TrustTier;
    stockVariantTier?: StockVariantTier;
    tags: string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
    isActive: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface ListByAssetIdsEntry {
    assetId: string;
    variants: AssetVariantResult[];
}

export interface ListByMintsEntry {
    mint: string;
    variant: AssetVariantResult | null;
}

export interface SolanaApiVariantMarket {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    trade1h?: number | null;
    trade24h?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    decimals: number | null;
    logoURI: string | null;
    lastTradeAt?: number | null;
    asOf?: number | null;
    lastFetchedAt: number;
}

export interface SolanaApiVariant {
    variantId: string;
    mint: string;
    kind: AssetVariantKind;
    tags: string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
    stockVariantTier?: StockVariantTier;
    symbol?: string;
    name?: string;
    liquidityTier: TrustTier;
    trustTier: TrustTier;
    market: SolanaApiVariantMarket | null;
}

export interface SolanaDefaultVariantsViewResult {
    assetId: 'solana';
    updatedAt: number;
    variants: SolanaApiVariant[];
}

export interface ListSolanaVariantsForApiResult {
    assetId: 'solana';
    requestedMintIsVariant: boolean;
    variants: SolanaApiVariant[];
}

function isAssetVariantKind(value: unknown): value is AssetVariantKind {
    return typeof value === 'string' && (ASSET_VARIANT_KINDS as readonly string[]).includes(value);
}

function isTrustTier(value: unknown): value is TrustTier {
    return typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value);
}

function isChainKind(value: unknown): value is ChainKind {
    return value === 'solana';
}

function isStockVariantTier(value: unknown): value is StockVariantTier {
    return value === 'share_redeemable' || value === 'cash_redeemable' || value === 'not_redeemable';
}

function normalizeTrustTier(value: unknown): TrustTier {
    return normalizeLegacyTier(typeof value === 'string' ? value : null) ?? 'tier3';
}

function optionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toFiniteNumberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rowToVariantResult(row: AssetVariantDocRow): AssetVariantResult {
    const chain: ChainKind = isChainKind(row.chain) ? row.chain : 'solana';
    const kind: AssetVariantKind = isAssetVariantKind(row.kind) ? row.kind : 'native';
    const out: AssetVariantResult = {
        assetId: row.asset_id,
        chain,
        mint: row.mint,
        variantId: row.variant_id,
        kind,
        trustTier: normalizeTrustTier(row.trust_tier),
        tags: row.tags,
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (row.issuer !== null) out.issuer = row.issuer;
    if (row.issuer_url !== null) out.issuerUrl = row.issuer_url;
    if (row.label !== null) out.label = row.label;
    if (row.stock_variant_tier !== null && isStockVariantTier(row.stock_variant_tier)) {
        out.stockVariantTier = row.stock_variant_tier;
    }
    return out;
}

function readString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
    return value;
}

function readOptionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        throw new InvalidArgsError(`${key} must be a boolean`);
    }
    return value;
}

function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
        throw new InvalidArgsError(`${key} must be a string`);
    }
    return value;
}

function asObject(args: unknown): Record<string, unknown> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    return args as Record<string, unknown>;
}

export async function getByMint(
    repo: AssetVariantsRepo,
    args: unknown,
): Promise<AssetVariantResult | null> {
    const a = asObject(args);
    const mintRaw = readString(a, 'mint');
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const mint = mintRaw.trim();
    if (!mint) return null;

    const doc = await repo.findVariantByMint(mint);
    if (!doc) return null;
    if (!includeInactive && !doc.is_active) return null;

    if (!includeInactive) {
        const assetIsActive = await repo.findAssetIsActive(doc.asset_id);
        if (assetIsActive !== true) return null;
    }

    return rowToVariantResult(doc);
}

export async function listByAssetIds(
    repo: AssetVariantsRepo,
    args: unknown,
): Promise<ListByAssetIdsEntry[]> {
    const a = asObject(args);
    const rawList = a.assetIds;
    if (!Array.isArray(rawList)) {
        throw new InvalidArgsError('assetIds must be an array of strings');
    }
    for (const item of rawList) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('assetIds must be an array of strings');
        }
    }
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;

    const assetIds = (rawList as string[])
        .slice(0, 250)
        .map(id => id.trim())
        .filter(id => id.length > 0);

    if (assetIds.length === 0) return [];

    const docs = await repo.findVariantsByAssetIds(assetIds, includeInactive);
    const grouped = new Map<string, AssetVariantDocRow[]>();
    for (const id of assetIds) grouped.set(id, []);
    for (const doc of docs) {
        const list = grouped.get(doc.asset_id);
        if (list) list.push(doc);
    }

    return assetIds.map(assetId => ({
        assetId,
        variants: (grouped.get(assetId) ?? []).map(rowToVariantResult),
    }));
}

export async function listByMints(
    repo: AssetVariantsRepo,
    args: unknown,
): Promise<ListByMintsEntry[]> {
    const a = asObject(args);
    const rawList = a.mints;
    if (!Array.isArray(rawList)) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    for (const item of rawList) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('mints must be an array of strings');
        }
    }
    const includeInactive = readOptionalBoolean(a, 'includeInactive') ?? false;
    const mints = (rawList as string[])
        .slice(0, 250)
        .map(m => m.trim())
        .filter(Boolean);

    if (mints.length === 0) return [];

    const results: ListByMintsEntry[] = [];
    const docsByMint = new Map<string, AssetVariantDocRow>();
    const docs = await repo.findVariantsByMints(mints);
    for (const doc of docs) docsByMint.set(doc.mint, doc);

    const assetActiveCache = new Map<string, boolean | null>();
    for (const mint of mints) {
        const doc = docsByMint.get(mint);
        if (!doc) {
            results.push({ mint, variant: null });
            continue;
        }
        if (!includeInactive && !doc.is_active) {
            results.push({ mint, variant: null });
            continue;
        }
        if (!includeInactive) {
            let isActive = assetActiveCache.get(doc.asset_id);
            if (isActive === undefined) {
                isActive = await repo.findAssetIsActive(doc.asset_id);
                assetActiveCache.set(doc.asset_id, isActive);
            }
            if (isActive !== true) {
                results.push({ mint, variant: null });
                continue;
            }
        }
        results.push({ mint, variant: rowToVariantResult(doc) });
    }

    return results;
}

function hasFreshVariantMarketRow(row: VariantMarketRow | undefined): boolean {
    return Boolean(row && Number.isFinite(row.last_fetched_at) && row.last_fetched_at > 0);
}

function pickTopTokenMarket(markets: unknown): Record<string, unknown> | null {
    if (!Array.isArray(markets)) return null;
    const validMarkets = markets.filter(
        (market): market is Record<string, unknown> =>
            !!market &&
            typeof market === 'object' &&
            typeof (market as { address?: unknown }).address === 'string' &&
            (market as { address: string }).address.length > 0,
    );
    if (validMarkets.length === 0) return null;

    const sorted = validMarkets
        .slice()
        .sort(
            (a, b) =>
                toFiniteNumberOrZero((b as { liquidity?: unknown }).liquidity) -
                    toFiniteNumberOrZero((a as { liquidity?: unknown }).liquidity) ||
                toFiniteNumberOrZero((b as { volume24h?: unknown }).volume24h) -
                    toFiniteNumberOrZero((a as { volume24h?: unknown }).volume24h),
        );
    return (
        sorted.find(market => toFiniteNumberOrZero((market as { price?: unknown }).price) > 0) ??
        sorted[0] ??
        null
    );
}

function deriveMarketFromTokenMarketRow(
    row: TokenMarketRow | undefined,
    mint: string,
): { market: SolanaApiVariantMarket; symbol?: string; name?: string } | null {
    if (!row || !Number.isFinite(row.last_fetched_at) || row.last_fetched_at <= 0) return null;
    const topMarket = pickTopTokenMarket(row.markets);
    if (!topMarket) return null;

    const base = (topMarket as { base?: Record<string, unknown> | null }).base ?? null;
    const quote = (topMarket as { quote?: Record<string, unknown> | null }).quote ?? null;
    const token =
        base && typeof (base as { address?: unknown }).address === 'string' && (base as { address: string }).address === mint
            ? base
            : quote &&
                typeof (quote as { address?: unknown }).address === 'string' &&
                (quote as { address: string }).address === mint
              ? quote
              : (base ?? quote ?? null);

    const symbol = optionalText((token as { symbol?: unknown } | null)?.symbol);
    const name =
        optionalText((token as { name?: unknown } | null)?.name) ??
        optionalText((topMarket as { name?: unknown }).name);

    const sourceVal = (row.source ?? '') as string;
    const source =
        sourceVal === 'birdeye' || sourceVal === 'rwa_xyz' || sourceVal === 'clickhouse_trades'
            ? sourceVal
            : undefined;

    const market: SolanaApiVariantMarket = {
        ...(source !== undefined ? { source } : {}),
        price: toFiniteNumberOrNull((topMarket as { price?: unknown }).price),
        liquidity: toFiniteNumberOrNull((topMarket as { liquidity?: unknown }).liquidity),
        volume24hUSD: toFiniteNumberOrNull((topMarket as { volume24h?: unknown }).volume24h),
        marketCap: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        decimals: toFiniteNumberOrNull((token as { decimals?: unknown } | null)?.decimals),
        logoURI: optionalText((token as { icon?: unknown } | null)?.icon),
        lastFetchedAt: row.last_fetched_at,
    };

    return {
        market,
        ...(symbol ? { symbol } : {}),
        ...(name ? { name } : {}),
    };
}

function compareSolanaApiVariants(a: SolanaApiVariant, b: SolanaApiVariant): number {
    const liqDelta = (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0);
    if (liqDelta !== 0) return liqDelta;
    const trustDelta = liquidityTierPriority(b.liquidityTier) - liquidityTierPriority(a.liquidityTier);
    if (trustDelta !== 0) return trustDelta;
    const volumeDelta = (b.market?.volume24hUSD ?? 0) - (a.market?.volume24hUSD ?? 0);
    if (volumeDelta !== 0) return volumeDelta;
    return a.mint.localeCompare(b.mint);
}

export interface SolanaVariantsForApiArgs {
    kind?: AssetVariantKind;
    tierFilter?: TrustTier;
    requestedMint?: string;
    variantsMode?: string;
}

export async function buildSolanaVariantsForApi(
    repo: AssetVariantsRepo,
    args: SolanaVariantsForApiArgs,
): Promise<ListSolanaVariantsForApiResult> {
    const requestedMint = args.requestedMint?.trim() || null;

    const docs = await repo.findActiveSolanaVariants();

    const requestedMintIsVariant = requestedMint ? docs.some(doc => doc.mint === requestedMint) : true;
    const candidates = args.kind ? docs.filter(doc => doc.kind === args.kind) : docs;
    if (candidates.length === 0) {
        return { assetId: 'solana' as const, requestedMintIsVariant, variants: [] };
    }

    const candidateMints = candidates.map(c => c.mint);
    const marketRows = await repo.findVariantMarketsByMints(candidateMints);
    const marketByMint = new Map(marketRows.map(r => [r.mint, r] as const));

    const shouldApplyYieldCap = args.variantsMode !== 'all' && (!args.kind || args.kind === 'yield');

    const fallbackMints = shouldApplyYieldCap
        ? Array.from(
              new Set(
                  candidates
                      .filter(doc => {
                          const marketRow = marketByMint.get(doc.mint);
                          return !hasFreshVariantMarketRow(marketRow) && (doc.kind === 'yield' || args.tierFilter);
                      })
                      .map(doc => doc.mint),
              ),
          )
        : [];
    const tokenMarketRows = fallbackMints.length > 0 ? await repo.findTokenMarketsByMints(fallbackMints) : [];
    const tokenMarketByMint = new Map(tokenMarketRows.map(r => [r.mint, r] as const));

    const variants: SolanaApiVariant[] = candidates.map(doc => {
        const marketRow = marketByMint.get(doc.mint);
        const freshMarketRow = hasFreshVariantMarketRow(marketRow) ? marketRow! : null;
        const tokenMarketDerived = freshMarketRow
            ? null
            : deriveMarketFromTokenMarketRow(tokenMarketByMint.get(doc.mint), doc.mint);

        const market: SolanaApiVariantMarket | null = freshMarketRow
            ? (() => {
                  const sourceVal = (freshMarketRow.source ?? '') as string;
                  const source =
                      sourceVal === 'birdeye' || sourceVal === 'rwa_xyz' || sourceVal === 'clickhouse_trades'
                          ? sourceVal
                          : undefined;
                  const metricsSourceVal = (freshMarketRow.metrics_source ?? '') as string;
                  const metricsSource =
                      metricsSourceVal === 'birdeye' ||
                      metricsSourceVal === 'rwa_xyz' ||
                      metricsSourceVal === 'clickhouse_trades'
                          ? metricsSourceVal
                          : undefined;
                  const out: SolanaApiVariantMarket = {
                      ...(source !== undefined ? { source } : {}),
                      ...(metricsSource !== undefined ? { metricsSource } : {}),
                      price: toFiniteNumberOrNull(freshMarketRow.price),
                      liquidity: toFiniteNumberOrNull(freshMarketRow.liquidity),
                      volume24hUSD: toFiniteNumberOrNull(freshMarketRow.volume_24h_usd),
                      marketCap: toFiniteNumberOrNull(freshMarketRow.market_cap),
                      priceChange24hPercent: toFiniteNumberOrNull(freshMarketRow.price_change_24h_percent),
                      priceChange1hPercent: toFiniteNumberOrNull(freshMarketRow.price_change_1h_percent),
                      decimals: toFiniteNumberOrNull(freshMarketRow.decimals),
                      logoURI: optionalText(resolveLogoUri(freshMarketRow)),
                      lastFetchedAt: freshMarketRow.last_fetched_at,
                  };
                  if (freshMarketRow.volume_1h_usd !== null) {
                      out.volume1hUSD = toFiniteNumberOrNull(freshMarketRow.volume_1h_usd);
                  }
                  if (freshMarketRow.trade_1h !== null) {
                      out.trade1h = toFiniteNumberOrNull(freshMarketRow.trade_1h);
                  }
                  if (freshMarketRow.trade_24h !== null) {
                      out.trade24h = toFiniteNumberOrNull(freshMarketRow.trade_24h);
                  }
                  if (freshMarketRow.unique_wallet_1h !== null) {
                      out.uniqueWallet1h = toFiniteNumberOrNull(freshMarketRow.unique_wallet_1h);
                  }
                  if (freshMarketRow.unique_wallet_24h !== null) {
                      out.uniqueWallet24h = toFiniteNumberOrNull(freshMarketRow.unique_wallet_24h);
                  }
                  if (freshMarketRow.last_trade_at !== null) {
                      out.lastTradeAt = toFiniteNumberOrNull(freshMarketRow.last_trade_at);
                  }
                  if (freshMarketRow.as_of !== null) {
                      out.asOf = toFiniteNumberOrNull(freshMarketRow.as_of);
                  }
                  return out;
              })()
            : (tokenMarketDerived?.market ?? null);

        const liquidityTier = classifyLiquidityTier(market?.liquidity ?? null);
        const symbol =
            optionalText(freshMarketRow?.symbol) ?? tokenMarketDerived?.symbol ?? undefined;
        const name = optionalText(freshMarketRow?.name) ?? tokenMarketDerived?.name ?? undefined;
        const kind: AssetVariantKind = isAssetVariantKind(doc.kind) ? doc.kind : 'native';

        const variant: SolanaApiVariant = {
            variantId: doc.variant_id,
            mint: doc.mint,
            kind,
            tags: doc.tags,
            liquidityTier,
            trustTier: liquidityTier,
            market,
        };
        if (doc.issuer !== null) variant.issuer = doc.issuer;
        if (doc.issuer_url !== null) variant.issuerUrl = doc.issuer_url;
        if (doc.label !== null) variant.label = doc.label;
        if (doc.stock_variant_tier !== null && isStockVariantTier(doc.stock_variant_tier)) {
            variant.stockVariantTier = doc.stock_variant_tier;
        }
        if (symbol) variant.symbol = symbol;
        if (name) variant.name = name;
        return variant;
    });

    let visibleVariants = args.tierFilter
        ? variants.filter(variant => variant.liquidityTier === args.tierFilter)
        : variants;

    visibleVariants.sort(compareSolanaApiVariants);

    if (shouldApplyYieldCap) {
        const SOLANA_YIELD_MIN_LIQUIDITY_USD = 250_000;
        const SOLANA_YIELD_MAX = 500;

        const yieldRows = visibleVariants.filter(v => v.kind === 'yield');
        const pinnedMint =
            requestedMint && visibleVariants.some(v => v.mint === requestedMint && v.kind === 'yield')
                ? requestedMint
                : null;
        const pinnedRow = pinnedMint ? (yieldRows.find(v => v.mint === pinnedMint) ?? null) : null;

        let keepYield = yieldRows.filter(
            v => v.mint === pinnedMint || (v.market?.liquidity ?? 0) >= SOLANA_YIELD_MIN_LIQUIDITY_USD,
        );
        if (keepYield.length > SOLANA_YIELD_MAX) keepYield = keepYield.slice(0, SOLANA_YIELD_MAX);
        if (pinnedRow && !keepYield.some(v => v.mint === pinnedRow.mint)) {
            keepYield = [...keepYield.slice(0, Math.max(0, SOLANA_YIELD_MAX - 1)), pinnedRow];
        }

        const keepYieldMints = new Set(keepYield.map(v => v.mint));
        visibleVariants = visibleVariants.filter(v => v.kind !== 'yield' || keepYieldMints.has(v.mint));
    }

    return {
        assetId: 'solana' as const,
        requestedMintIsVariant,
        variants: visibleVariants,
    };
}

export async function getSolanaDefaultVariantsViewForApi(
    repo: AssetVariantsRepo,
    args: unknown,
): Promise<SolanaDefaultVariantsViewResult | null> {
    void args;
    const row = await repo.findSolanaDefaultVariantsView();
    if (!row) return null;
    const parsed = JSON.parse(row.variants_json) as SolanaApiVariant[];
    return {
        assetId: 'solana' as const,
        updatedAt: row.updated_at,
        variants: parsed,
    };
}

export async function listSolanaVariantsForApi(
    repo: AssetVariantsRepo,
    args: unknown,
): Promise<ListSolanaVariantsForApiResult> {
    const a = asObject(args);
    const kindArg = readOptionalString(a, 'kind');
    const tierArg = readOptionalString(a, 'tierFilter');
    const requestedMintArg = readOptionalString(a, 'requestedMint');
    const variantsModeArg = readOptionalString(a, 'variantsMode');

    const built: SolanaVariantsForApiArgs = {};
    if (kindArg !== undefined) {
        if (!isAssetVariantKind(kindArg)) {
            throw new InvalidArgsError('kind must be a valid asset variant kind');
        }
        built.kind = kindArg;
    }
    if (tierArg !== undefined) {
        if (!isTrustTier(tierArg)) {
            throw new InvalidArgsError('tierFilter must be a valid trust tier');
        }
        built.tierFilter = tierArg;
    }
    if (requestedMintArg !== undefined) built.requestedMint = requestedMintArg;
    if (variantsModeArg !== undefined) built.variantsMode = variantsModeArg;

    return buildSolanaVariantsForApi(repo, built);
}

export { SOLANA_DEFAULT_VARIANTS_VIEW_KEY };
