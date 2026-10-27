/**
 * Core types for the v2 token search judgment layer.
 *
 * Design principles:
 * - The mint is the only identifier. Symbol/name are adversarial *claims*
 *   whose credibility is established by attestations.
 * - The pipeline stages (intent → gates → score → explain → resolve) are pure
 *   functions over `EnrichedCandidate` so they can be tested offline.
 * - Provider names are never leaked into the public contract; candidate
 *   sources are reported as `provider` / `db` / `registry` / `caller`.
 */

import type { VariantAdvisory } from '@tokens/asset-registry';

export const SCORING_VERSION = 'v2-scoring-2026-10-26.1' as const;

/**
 * Where a candidate was found. `caller` = supplied in the body of
 * `POST /v2/judge` (claims with the same trust as the live provider's).
 */
export type CandidateSource = 'provider' | 'db' | 'registry' | 'caller';

/** A fully-enriched candidate token: input to the pure judgment pipeline. */
export interface EnrichedCandidate {
    mint: string;
    /** Claimed symbol (attacker-controlled metadata). */
    symbol: string | null;
    /** Claimed name (attacker-controlled metadata). */
    name: string | null;
    decimals: number | null;
    logoURI: string | null;
    price: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    marketCapUsd: number | null;
    priceChange24hPercent: number | null;
    holderCount: number | null;
    top10HoldersPercent: number | null;
    /** Token mint (creation) time, ISO string, when known. */
    tokenMintTime: string | null;
    /** Distinct wallets that traded in the last 24h (wash-resistant activity). */
    uniqueWallet24h: number | null;
    trade24h: number | null;
    fdv: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    /** ms epoch of the last observed trade. */
    lastTradeAt: number | null;
    /** Registry asset category (`stablecoin`, `equity`, …) when registry-attested; selects the band. */
    category: string | null;
    /**
     * Authority / launch-hygiene facts. `null` = unknown. Each flag is
     * independently nullable: absence is never read as "safe".
     */
    security: {
        mintable: boolean | null;
        freezable: boolean | null;
        mutableMetadata: boolean | null;
        transferTax: boolean | null;
        lpLockedPercent: number | null;
        devHoldingPercent: number | null;
        sniperHoldingPercent: number | null;
        bundlerHoldingPercent: number | null;
    } | null;
    /** Where each judgment input came from (echoed on every result). */
    dataSources: DataSources;
    /** Where this candidate was found. */
    sources: CandidateSource[];
    /**
     * Curated list ids this mint belongs to (strongest attestation).
     * DB-backed effective membership — populated for admin-added tokens the
     * compiled registry has never heard of, not just registry variants.
     */
    curatedListIds: string[];
    /** Canonical-registry match, when the mint is a known variant. */
    registry: {
        assetId: string;
        symbol: string | null;
        name: string | null;
        kind: string | null;
        trustTier: string | null;
    } | null;
    /** Cached risk snapshot, when available. Absence means "unknown", not "bad". */
    risk: {
        marketScore: number | null;
        grade: 'A' | 'B' | 'C' | null;
        webacyTags: string[];
    } | null;
    /** Execution quality snapshot, when available. */
    fillQuality: {
        executionScore: number | null;
        botVolumeRatio: number | null;
        flowSourceCount?: number | null;
        markoutBps?: number | null;
    } | null;
    /** Mint (or its refs) has an explicit deletion tombstone. */
    tombstoned: boolean;
    /**
     * Active admin advisory on the mint. `blocked`/`compromised` suppress under
     * every policy; `caution` is a warning. Absence (`null`) means "no advisory".
     */
    advisory: VariantAdvisory | null;
    /** Millis timestamp of the freshest market data backing this candidate. */
    dataAsOf: number | null;
}

/** Origin of a judgment input: our stored snapshot, a live provider lookup, the caller's claim, or nothing. */
export type DataSourceKind = 'snapshot' | 'provider' | 'caller' | 'none';

export interface DataSources {
    /** price / liquidity / volume / market cap / holders */
    market: DataSourceKind;
    /** top-10 holder share and mint time */
    holders: DataSourceKind;
    /** authority flags, LP lock, launch hygiene */
    security: DataSourceKind;
}

export const NO_DATA_SOURCES: DataSources = { market: 'none', holders: 'none', security: 'none' };

// -----------------------------------------------------------------------------
// Explanation codes (public contract — documented, typed, stable)
// -----------------------------------------------------------------------------

export const REASON_CODES = [
    'mint_match',
    'exact_symbol_match',
    'exact_name_match',
    'symbol_prefix_match',
    'name_match',
    'alias_match',
    'curated_list_member',
    'registry_variant',
    'market_leader',
    'deep_liquidity',
    'high_activity',
    'established_token',
    'strong_execution_quality',
    'active_wallets',
    'locked_liquidity',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const WARNING_CODES = [
    'low_liquidity',
    'no_market_data',
    'possible_impersonation',
    'symbol_collision',
    'suspicious_characters',
    'new_token',
    'stale_data',
    'high_bot_volume',
    'concentrated_holders',
    'unverified',
    'weak_market_score',
    'advisory_caution',
    'mint_authority_active',
    'freeze_authority_active',
    'mutable_metadata',
    'transfer_tax',
    'low_lp_locked',
    'dev_holding_high',
    'sniper_bundle_heavy',
    'thin_float',
    'no_recent_trades',
    'toxic_flow',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const SUPPRESSION_CODES = [
    'gate_tombstoned',
    'gate_advisory_blocked',
    'gate_advisory_compromised',
    'gate_min_liquidity',
    'gate_no_market_data',
    'gate_impersonation',
    'gate_min_market_score',
    'gate_new_token',
    'gate_unverified',
    'gate_unsafe_authorities',
] as const;
export type SuppressionCode = (typeof SUPPRESSION_CODES)[number];

export type AttestationCode =
    | 'curated_list'
    | 'registry_variant'
    | 'market_dominance'
    | 'deep_liquidity'
    | 'sustained_activity'
    | 'established_age'
    | 'broad_holder_base'
    | 'active_wallets'
    | 'locked_liquidity';

export interface Attestation {
    code: AttestationCode;
    /** Human-readable evidence, e.g. `curated list: majors`. */
    detail: string;
}

// -----------------------------------------------------------------------------
// Scoring output
// -----------------------------------------------------------------------------

export type ScoreComponentKey = 'matchQuality' | 'claimCredibility' | 'liquidity' | 'activity' | 'risk' | 'freshness';

export type ScoreComponents = Record<ScoreComponentKey, number>;

export interface JudgedToken {
    mint: string;
    claims: {
        symbol: string | null;
        name: string | null;
        attestations: Attestation[];
    };
    market: {
        price: number | null;
        liquidityUsd: number | null;
        volume24hUsd: number | null;
        marketCapUsd: number | null;
        priceChange24hPercent: number | null;
        holderCount: number | null;
        decimals: number | null;
        logoURI: string | null;
        dataAsOf: number | null;
    };
    score: {
        total: number;
        components: ScoreComponents;
    };
    reasons: ReasonCode[];
    warnings: WarningCode[];
    badges: string[];
    /** Where this result's market, holder and security inputs came from. */
    dataSources: DataSources;
}

export interface SuppressedToken {
    mint: string;
    symbol: string | null;
    name: string | null;
    liquidityUsd: number | null;
    suppressedBy: SuppressionCode[];
    warnings: WarningCode[];
}

export type QueryIntent = 'mint' | 'ticker' | 'name';

export interface QueryInterpretation {
    intent: QueryIntent;
    /** Homoglyph/zero-width-normalized uppercase form used for matching. */
    normalizedQuery: string;
    /** Query contained confusable/invisible characters. */
    hadSuspiciousCharacters: boolean;
}

export type ResolveStatus = 'resolved' | 'ambiguous' | 'no_confident_match';
