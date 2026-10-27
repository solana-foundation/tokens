/**
 * Claim normalization + attestations.
 *
 * Onchain symbol/name metadata is adversarial input: anyone can deploy a mint
 * whose symbol is `USDC` — including with Cyrillic/Greek confusables or
 * zero-width characters. All matching therefore runs over a normalized form:
 * NFKC → strip invisibles → map confusables to Latin → uppercase.
 */

import { bandFor } from './bands';
import type { Attestation, EnrichedCandidate } from './types';

// Zero-width and invisible formatting characters commonly used in spoofing.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

// Common Cyrillic/Greek → Latin confusables (covers the practical spoof set;
// NFKC handles fullwidth/compatibility forms separately).
const CONFUSABLES: Record<string, string> = {
    // Cyrillic uppercase
    А: 'A',
    В: 'B',
    Е: 'E',
    Ѕ: 'S',
    І: 'I',
    Ј: 'J',
    К: 'K',
    М: 'M',
    Н: 'H',
    О: 'O',
    Р: 'P',
    С: 'C',
    Т: 'T',
    У: 'Y',
    Х: 'X',
    Ь: 'B',
    // Cyrillic lowercase
    а: 'a',
    е: 'e',
    ѕ: 's',
    і: 'i',
    ј: 'j',
    к: 'k',
    м: 'm',
    н: 'h',
    о: 'o',
    р: 'p',
    с: 'c',
    т: 't',
    у: 'y',
    х: 'x',
    // Greek uppercase
    Α: 'A',
    Β: 'B',
    Ε: 'E',
    Ζ: 'Z',
    Η: 'H',
    Ι: 'I',
    Κ: 'K',
    Μ: 'M',
    Ν: 'N',
    Ο: 'O',
    Ρ: 'P',
    Τ: 'T',
    Υ: 'Y',
    Χ: 'X',
    // Greek lowercase
    α: 'a',
    ο: 'o',
    ρ: 'p',
    τ: 't',
    υ: 'u',
    ν: 'v',
};

const CONFUSABLE_PATTERN = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');

export interface NormalizedClaim {
    /** Normalized uppercase form used for equality/collision checks. */
    normalized: string;
    /** Original contained invisible or confusable characters. */
    hadSuspiciousCharacters: boolean;
}

export function normalizeClaim(raw: string | null | undefined): NormalizedClaim {
    const value = (raw ?? '').trim();
    if (!value) return { normalized: '', hadSuspiciousCharacters: false };

    const nfkc = value.normalize('NFKC');
    const withoutInvisibles = nfkc.replace(INVISIBLE_CHARS, '');
    const deconfused = withoutInvisibles.replace(CONFUSABLE_PATTERN, ch => CONFUSABLES[ch] ?? ch);

    const hadSuspiciousCharacters = withoutInvisibles !== nfkc || deconfused !== withoutInvisibles || nfkc !== value;

    // `$WIF` and `WIF` are the same claim: strip decorative dollar prefixes so
    // exact-symbol matching and collision detection treat them as equivalent.
    // Not flagged as suspicious — `$`-prefixing is common legitimate branding
    // (and equivalence is exactly what makes a hostile `$USDC` collide with
    // the protected `USDC`).
    const withoutDollarPrefix = deconfused.replace(/^\$+/, '');

    return {
        normalized: withoutDollarPrefix.toUpperCase(),
        hadSuspiciousCharacters,
    };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function tokenAgeDays(candidate: Pick<EnrichedCandidate, 'tokenMintTime'>, nowMs: number): number | null {
    if (!candidate.tokenMintTime) return null;
    const mintedAt = Date.parse(candidate.tokenMintTime);
    if (!Number.isFinite(mintedAt)) return null;
    return Math.max(0, (nowMs - mintedAt) / DAY_MS);
}

/**
 * Attestations: independent evidence that a candidate's symbol/name claims are
 * credible. Absence of attestations means "unknown", not "fake" — but an
 * unattested exact match on a protected symbol is treated as hostile.
 */
export function buildAttestations(
    candidate: EnrichedCandidate,
    nowMs: number,
    extras?: { marketDominanceDetail?: string },
): Attestation[] {
    const attestations: Attestation[] = [];
    const band = bandFor(candidate);

    if (candidate.curatedListIds.length > 0) {
        attestations.push({
            code: 'curated_list',
            detail: `curated list: ${candidate.curatedListIds.join(', ')}`,
        });
    }

    if (candidate.registry) {
        attestations.push({
            code: 'registry_variant',
            detail: `registry asset: ${candidate.registry.assetId}`,
        });
    }

    if (extras?.marketDominanceDetail) {
        attestations.push({
            code: 'market_dominance',
            detail: extras.marketDominanceDetail,
        });
    }

    if ((candidate.liquidityUsd ?? 0) >= band.deepLiquidityUsd) {
        attestations.push({
            code: 'deep_liquidity',
            detail: `liquidity ≥ $${formatUsd(band.deepLiquidityUsd)}${band.id === 'default' ? '' : ` (${band.id} band)`}`,
        });
    }

    if ((candidate.volume24hUsd ?? 0) >= band.sustainedVolumeUsd) {
        attestations.push({
            code: 'sustained_activity',
            detail: `24h volume ≥ $${formatUsd(band.sustainedVolumeUsd)}${band.id === 'default' ? '' : ` (${band.id} band)`}`,
        });
    }

    const ageDays = tokenAgeDays(candidate, nowMs);
    if (ageDays !== null && ageDays >= 90) {
        attestations.push({
            code: 'established_age',
            detail: `minted ≥ 90 days ago`,
        });
    }

    if ((candidate.holderCount ?? 0) >= 10_000) {
        attestations.push({
            code: 'broad_holder_base',
            detail: `holders ≥ 10K`,
        });
    }

    // Distinct trading wallets are the wash-resistant twin of volume.
    if ((candidate.uniqueWallet24h ?? 0) >= ACTIVE_WALLETS_MIN) {
        attestations.push({
            code: 'active_wallets',
            detail: `≥ ${ACTIVE_WALLETS_MIN.toLocaleString('en-US')} distinct wallets traded in 24h`,
        });
    }

    if ((candidate.security?.lpLockedPercent ?? 0) >= LOCKED_LIQUIDITY_MIN_PERCENT) {
        attestations.push({
            code: 'locked_liquidity',
            detail: `≥ ${LOCKED_LIQUIDITY_MIN_PERCENT}% of liquidity locked or burned`,
        });
    }

    return attestations;
}

export const ACTIVE_WALLETS_MIN = 1_000;
export const LOCKED_LIQUIDITY_MIN_PERCENT = 80;

function formatUsd(value: number): string {
    if (value >= 1_000_000) return `${value / 1_000_000}M`;
    if (value >= 1_000) return `${value / 1_000}K`;
    return String(value);
}

/** 0–100: how much independent evidence backs this candidate's claims. */
export function claimCredibilityScore(attestations: Attestation[]): number {
    const WEIGHTS: Record<Attestation['code'], number> = {
        curated_list: 40,
        registry_variant: 20,
        market_dominance: 20,
        deep_liquidity: 15,
        sustained_activity: 10,
        established_age: 10,
        broad_holder_base: 5,
        active_wallets: 10,
        locked_liquidity: 10,
    };
    let score = 0;
    for (const attestation of attestations) score += WEIGHTS[attestation.code] ?? 0;
    return Math.min(100, score);
}
