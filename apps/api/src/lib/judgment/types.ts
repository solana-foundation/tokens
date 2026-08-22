/**
 * Core types for the v2 token search judgment layer.
 *
 * Design principles:
 * - The mint is the only identifier. Symbol/name are adversarial *claims*
 *   whose credibility is established by attestations.
 * - The pipeline stages (intent → gates → score → explain → resolve) are pure
 *   functions over `EnrichedCandidate` so they can be tested offline.
 * - Provider names are never leaked into the public contract; candidate
 *   sources are reported as `provider` / `db` / `registry`.
 */

export const SCORING_VERSION = 'v2-scoring-2026-07-05.1' as const;

export type CandidateSource = 'provider' | 'db' | 'registry';

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
    /** Where this candidate was found. */
    sources: CandidateSource[];
    /** Canonical-registry match, when the mint is a known variant. */
    registry: {
        assetId: string;
        symbol: string | null;
        name: string | null;
        kind: string | null;
        trustTier: string | null;
        /** Curated list ids this mint belongs to (strongest attestation). */
        curatedListIds: string[];
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
    } | null;
    /** Mint (or its refs) has an explicit deletion tombstone. */
    tombstoned: boolean;
    /** Millis timestamp of the freshest market data backing this candidate. */
    dataAsOf: number | null;
}

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
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const SUPPRESSION_CODES = [
    'gate_tombstoned',
    'gate_min_liquidity',
    'gate_no_market_data',
    'gate_impersonation',
    'gate_min_market_score',
    'gate_new_token',
] as const;
export type SuppressionCode = (typeof SUPPRESSION_CODES)[number];

export type AttestationCode =
    | 'curated_list'
    | 'registry_variant'
    | 'market_dominance'
    | 'deep_liquidity'
    | 'sustained_activity'
    | 'established_age'
    | 'broad_holder_base';

export interface Attestation {
    code: AttestationCode;
    /** Human-readable evidence, e.g. `curated list: majors`. */
    detail: string;
}

// -----------------------------------------------------------------------------
// Scoring output
// -----------------------------------------------------------------------------

export type ScoreComponentKey =
    | 'matchQuality'
    | 'claimCredibility'
    | 'liquidity'
    | 'activity'
    | 'risk'
    | 'freshness';

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
