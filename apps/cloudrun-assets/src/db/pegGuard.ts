/**
 * Postgres implementation of `PegGuardRepo` (handlers/crons.pegGuard.ts): the
 * peg guard's own observation cache from migration 0020 plus the two reads it
 * needs from the asset tables (variant identity for the peg lookup, and the
 * `variant_markets_latest` price as a Birdeye fallback).
 *
 * Advisory writes go through `DepegRepo` (db/depeg.ts), shared with the Webacy
 * job, so the ownership rules live in exactly one place.
 */

import type { Sql } from 'postgres';

import { isPegReferenceKind, isPegTier, type PegReferenceKind, type PegTier } from '@tokens/asset-registry';

import { randomId } from '../db';

export type PegGuardTrigger = 'sweep' | 'manual';
export type PegGuardPriceSource = 'birdeye_multi_price' | 'variant_markets_latest';

/** One `peg_guard_latest` row (camelCase). Unix ms timestamps. */
export interface PegGuardLatestRow {
    chain: string;
    address: string;
    symbol: string | null;
    /** ISO 4217 code of the peg; null when unknown. */
    pegCurrency: string | null;
    /** USD value the price was judged against: 1 (fixed), the fx rate, or the high-water mark; null when unresolved. */
    pegUsd: number | null;
    priceUsd: number | null;
    liquidityUsd: number | null;
    /** Signed percent from peg; negative means below. */
    deviationPct: number | null;
    tier: PegTier | null;
    prevTier: PegTier | null;
    tierSinceAt: number | null;
    badSinceAt: number | null;
    observations: number;
    /** False when the observation could not be evaluated; `tier` is then the last good value. */
    ok: boolean;
    /** thin_liquidity | stale_price | no_price | unsupported_peg | no_fx_rate | stale_fx | no_reference | fetch_failed */
    errorMessage: string | null;
    priceSource: PegGuardPriceSource | null;
    /** Provider timestamp of the price (unix ms); staleness is judged on this. */
    priceUpdatedAt: number | null;
    /** How `pegUsd` was derived; null when the mint has no known peg. */
    referenceKind: PegReferenceKind | null;
    /**
     * High-water reference for yield-bearing variants (only rises, only on
     * liquid observations). Null for other kinds. The upsert COALESCEs both
     * columns so a failed observation never drops the mark.
     */
    referenceUsd: number | null;
    /** Unix ms when `referenceUsd` last moved. */
    referenceUpdatedAt: number | null;
    lastFetchedAt: number;
    /** Unix ms of the last successful evaluation; untouched by failures so staleness is measurable. */
    lastOkAt: number | null;
}

export interface PegGuardTierEventRow {
    chain: string;
    address: string;
    oldTier: PegTier | null;
    newTier: PegTier;
    deviationPct: number | null;
    priceUsd: number | null;
    pegUsd: number | null;
    liquidityUsd: number | null;
    referenceKind: PegReferenceKind | null;
    source: PegGuardTrigger;
    observedAt: number;
}

/** One `peg_fx_rates_latest` row: CoinGecko-implied USD value of one unit of a fiat peg currency. */
export interface FxRateRow {
    /** ISO 4217 code, upper case. */
    currency: string;
    usdPerUnit: number;
    source: 'coingecko_usd_coin' | 'coingecko_tether';
    /** CoinGecko's `last_updated_at` (unix ms); null when absent. */
    providerUpdatedAt: number | null;
    lastFetchedAt: number;
    /** Unix ms of the last successful fetch; the upsert COALESCEs it so a failure keeps the last success. */
    lastOkAt: number | null;
}

export interface PegGuardCurrencyVariant {
    assetId: string;
    variantId: string;
    symbol: string | null;
    kind: string;
    isActive: boolean;
}

export interface PegGuardMarketFallback {
    price: number | null;
    liquidity: number | null;
    /** Unix ms when the markets refresh last wrote the row. */
    lastFetchedAt: number;
}

export interface PegGuardRepo {
    listLatest(chain: string): Promise<PegGuardLatestRow[]>;
    upsertLatest(rows: readonly PegGuardLatestRow[]): Promise<void>;
    insertTierEvents(rows: readonly PegGuardTierEventRow[]): Promise<void>;
    /** Canonical Solana variant per mint (lowest id), with the token's symbol. */
    listCurrencyVariants(mints: readonly string[]): Promise<Map<string, PegGuardCurrencyVariant>>;
    /** Last price the markets refresh stored per mint; a fallback only. */
    listVariantMarketFallback(mints: readonly string[]): Promise<Map<string, PegGuardMarketFallback>>;
    /** Every stored fiat rate (the fallback when CoinGecko is down). */
    listFxRates(): Promise<FxRateRow[]>;
    upsertFxRates(rows: readonly FxRateRow[]): Promise<void>;
}

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : null;
}

function toTier(value: unknown): PegTier | null {
    return isPegTier(value) ? value : null;
}

function toPriceSource(value: unknown): PegGuardPriceSource | null {
    return value === 'birdeye_multi_price' || value === 'variant_markets_latest' ? value : null;
}

function toReferenceKind(value: unknown): PegReferenceKind | null {
    return isPegReferenceKind(value) ? value : null;
}

function toFxSource(value: unknown): FxRateRow['source'] | null {
    return value === 'coingecko_usd_coin' || value === 'coingecko_tether' ? value : null;
}

interface PgPegGuardLatestRow {
    chain: string;
    address: string;
    symbol: string | null;
    peg_currency: string | null;
    peg_usd: number | string | null;
    price_usd: number | string | null;
    liquidity_usd: number | string | null;
    deviation_pct: number | string | null;
    tier: string | null;
    prev_tier: string | null;
    tier_since_at: number | string | bigint | null;
    bad_since_at: number | string | bigint | null;
    observations: number | string;
    ok: boolean;
    error_message: string | null;
    price_source: string | null;
    price_updated_at: number | string | bigint | null;
    reference_kind: string | null;
    reference_usd: number | string | null;
    reference_updated_at: number | string | bigint | null;
    last_fetched_at: number | string | bigint;
    last_ok_at: number | string | bigint | null;
}

interface PgFxRateRow {
    currency: string;
    usd_per_unit: number | string;
    source: string;
    provider_updated_at: number | string | bigint | null;
    last_fetched_at: number | string | bigint;
    last_ok_at: number | string | bigint | null;
}

function mapLatest(row: PgPegGuardLatestRow): PegGuardLatestRow {
    return {
        chain: row.chain,
        address: row.address,
        symbol: row.symbol,
        pegCurrency: row.peg_currency,
        pegUsd: toNumberOrNull(row.peg_usd),
        priceUsd: toNumberOrNull(row.price_usd),
        liquidityUsd: toNumberOrNull(row.liquidity_usd),
        deviationPct: toNumberOrNull(row.deviation_pct),
        tier: toTier(row.tier),
        prevTier: toTier(row.prev_tier),
        tierSinceAt: toNumberOrNull(row.tier_since_at),
        badSinceAt: toNumberOrNull(row.bad_since_at),
        observations: toNumberOrNull(row.observations) ?? 0,
        ok: row.ok === true,
        errorMessage: row.error_message,
        priceSource: toPriceSource(row.price_source),
        priceUpdatedAt: toNumberOrNull(row.price_updated_at),
        referenceKind: toReferenceKind(row.reference_kind),
        referenceUsd: toNumberOrNull(row.reference_usd),
        referenceUpdatedAt: toNumberOrNull(row.reference_updated_at),
        lastFetchedAt: toNumberOrNull(row.last_fetched_at) ?? 0,
        lastOkAt: toNumberOrNull(row.last_ok_at),
    };
}

/** Rows with an unknown source or a non-positive rate are dropped: they cannot judge a peg. */
function mapFxRate(row: PgFxRateRow): FxRateRow | null {
    const source = toFxSource(row.source);
    const usdPerUnit = toNumberOrNull(row.usd_per_unit);
    if (!source || usdPerUnit === null || usdPerUnit <= 0) return null;
    return {
        currency: row.currency,
        usdPerUnit,
        source,
        providerUpdatedAt: toNumberOrNull(row.provider_updated_at),
        lastFetchedAt: toNumberOrNull(row.last_fetched_at) ?? 0,
        lastOkAt: toNumberOrNull(row.last_ok_at),
    };
}

export function makePostgresPegGuardRepo(sql: Sql): PegGuardRepo {
    return {
        async listLatest(chain) {
            const rows = await sql<PgPegGuardLatestRow[]>`
                SELECT chain, address, symbol, peg_currency, peg_usd, price_usd, liquidity_usd, deviation_pct,
                       tier, prev_tier, tier_since_at, bad_since_at, observations, ok, error_message,
                       price_source, price_updated_at, reference_kind, reference_usd, reference_updated_at,
                       last_fetched_at, last_ok_at
                FROM peg_guard_latest
                WHERE chain = ${chain}
            `;
            return rows.map(mapLatest);
        },

        async upsertLatest(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO peg_guard_latest (
                        id, chain, address, symbol, peg_currency, peg_usd, price_usd, liquidity_usd, deviation_pct,
                        tier, prev_tier, tier_since_at, bad_since_at, observations, ok, error_message,
                        price_source, price_updated_at, reference_kind, reference_usd, reference_updated_at,
                        last_fetched_at, last_ok_at
                    )
                    VALUES (
                        ${randomId('pgl')}, ${row.chain}, ${row.address}, ${row.symbol}, ${row.pegCurrency},
                        ${row.pegUsd}, ${row.priceUsd}, ${row.liquidityUsd}, ${row.deviationPct},
                        ${row.tier}, ${row.prevTier}, ${row.tierSinceAt}, ${row.badSinceAt}, ${row.observations},
                        ${row.ok}, ${row.errorMessage}, ${row.priceSource}, ${row.priceUpdatedAt},
                        ${row.referenceKind}, ${row.referenceUsd}, ${row.referenceUpdatedAt},
                        ${row.lastFetchedAt}, ${row.lastOkAt}
                    )
                    ON CONFLICT (chain, address) DO UPDATE SET
                        symbol = EXCLUDED.symbol,
                        peg_currency = EXCLUDED.peg_currency,
                        peg_usd = EXCLUDED.peg_usd,
                        price_usd = EXCLUDED.price_usd,
                        liquidity_usd = EXCLUDED.liquidity_usd,
                        deviation_pct = EXCLUDED.deviation_pct,
                        tier = EXCLUDED.tier,
                        prev_tier = EXCLUDED.prev_tier,
                        tier_since_at = EXCLUDED.tier_since_at,
                        bad_since_at = EXCLUDED.bad_since_at,
                        observations = EXCLUDED.observations,
                        ok = EXCLUDED.ok,
                        error_message = EXCLUDED.error_message,
                        price_source = EXCLUDED.price_source,
                        price_updated_at = EXCLUDED.price_updated_at,
                        -- A run that could not resolve the reference (NULL) must not drop the
                        -- high-water mark or forget what kind of reference the mint uses.
                        reference_kind = COALESCE(EXCLUDED.reference_kind, peg_guard_latest.reference_kind),
                        reference_usd = COALESCE(EXCLUDED.reference_usd, peg_guard_latest.reference_usd),
                        reference_updated_at = COALESCE(EXCLUDED.reference_updated_at, peg_guard_latest.reference_updated_at),
                        last_fetched_at = EXCLUDED.last_fetched_at,
                        -- A failed evaluation (NULL last_ok_at) must not erase the last success.
                        last_ok_at = COALESCE(EXCLUDED.last_ok_at, peg_guard_latest.last_ok_at)
                `;
            }
        },

        async insertTierEvents(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO peg_guard_tier_events (
                        id, chain, address, old_tier, new_tier, deviation_pct, price_usd, peg_usd, liquidity_usd,
                        reference_kind, source, observed_at
                    )
                    VALUES (
                        ${randomId('pgte')}, ${row.chain}, ${row.address}, ${row.oldTier}, ${row.newTier},
                        ${row.deviationPct}, ${row.priceUsd}, ${row.pegUsd}, ${row.liquidityUsd},
                        ${row.referenceKind}, ${row.source}, ${row.observedAt}
                    )
                `;
            }
        },

        async listCurrencyVariants(mints) {
            const out = new Map<string, PegGuardCurrencyVariant>();
            if (mints.length === 0) return out;
            // asset_variants has no symbol column: the token row carries the
            // per-mint symbol (USDC), the parent asset only the aggregate (USD).
            // Lowest variant id is the canonical row for a mint, as in db/depeg.ts.
            const rows = await sql<
                Array<{
                    mint: string;
                    asset_id: string;
                    variant_id: string;
                    kind: string;
                    is_active: boolean;
                    symbol: string | null;
                }>
            >`
                SELECT DISTINCT ON (v.mint)
                       v.mint, v.asset_id, v.variant_id, v.kind, v.is_active,
                       COALESCE(t.symbol, a.symbol) AS symbol
                FROM asset_variants v
                LEFT JOIN assets a ON a.asset_id = v.asset_id
                LEFT JOIN tokens t ON t.address = v.mint
                WHERE v.chain = 'solana'
                  AND v.mint = ANY(${sql.array([...mints])}::text[])
                ORDER BY v.mint, v.id ASC
            `;
            for (const row of rows) {
                out.set(row.mint, {
                    assetId: row.asset_id,
                    variantId: row.variant_id,
                    symbol: row.symbol,
                    kind: row.kind,
                    isActive: row.is_active === true,
                });
            }
            return out;
        },

        async listVariantMarketFallback(mints) {
            const out = new Map<string, PegGuardMarketFallback>();
            if (mints.length === 0) return out;
            const rows = await sql<
                Array<{
                    mint: string;
                    price: number | string | null;
                    liquidity: number | string | null;
                    last_fetched_at: number | string | bigint;
                }>
            >`
                SELECT mint, price, liquidity, last_fetched_at
                FROM variant_markets_latest
                WHERE mint = ANY(${sql.array([...mints])}::text[])
            `;
            for (const row of rows) {
                out.set(row.mint, {
                    price: toNumberOrNull(row.price),
                    liquidity: toNumberOrNull(row.liquidity),
                    lastFetchedAt: toNumberOrNull(row.last_fetched_at) ?? 0,
                });
            }
            return out;
        },

        async listFxRates() {
            const rows = await sql<PgFxRateRow[]>`
                SELECT currency, usd_per_unit, source, provider_updated_at, last_fetched_at, last_ok_at
                FROM peg_fx_rates_latest
            `;
            return rows.map(mapFxRate).filter((row): row is FxRateRow => row !== null);
        },

        async upsertFxRates(rows) {
            for (const row of rows) {
                await sql`
                    INSERT INTO peg_fx_rates_latest (
                        currency, usd_per_unit, source, provider_updated_at, last_fetched_at, last_ok_at
                    )
                    VALUES (
                        ${row.currency}, ${row.usdPerUnit}, ${row.source}, ${row.providerUpdatedAt},
                        ${row.lastFetchedAt}, ${row.lastOkAt}
                    )
                    ON CONFLICT (currency) DO UPDATE SET
                        usd_per_unit = EXCLUDED.usd_per_unit,
                        source = EXCLUDED.source,
                        provider_updated_at = EXCLUDED.provider_updated_at,
                        last_fetched_at = EXCLUDED.last_fetched_at,
                        -- A failed refresh (NULL last_ok_at) keeps the last success for the 6h fallback.
                        last_ok_at = COALESCE(EXCLUDED.last_ok_at, peg_fx_rates_latest.last_ok_at)
                `;
            }
        },
    };
}
