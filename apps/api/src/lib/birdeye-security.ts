import { Effect } from 'effect';

import { MissingEnvError } from '@tokens/effect';
import { fetchJsonWithRetry } from '@tokens/effect';

const BIRDEYE_API_URL = 'https://public-api.birdeye.so';

/**
 * Live holder-concentration, age and authority facts for one mint, in the
 * shape `asset_risk_latest` rows take so a live answer is a drop-in for a
 * missing stored row (Birdeye specifics stay in this module).
 */
export interface ProviderSecurity {
    top10HoldersPercent: number | null;
    /** ISO string when the provider knows the mint's creation time. */
    tokenMintTime: string | null;
    /** A mint authority still exists (supply can grow). `null` = unknown. */
    mintable: boolean | null;
    /** A freeze authority still exists (accounts can be frozen). */
    freezable: boolean | null;
    mutableMetadata: boolean | null;
    transferTax: boolean | null;
    nonTransferable: boolean | null;
    isToken2022: boolean | null;
    /** Share of the LP that is locked/burned when the provider reports it. */
    lpLockedPercent: number | null;
}

function toFinite(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toBool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function hasAddress(value: unknown): boolean | null {
    if (value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    return null;
}

function toPercent(value: unknown): number | null {
    const n = toFinite(value);
    if (n === null) return null;
    // Birdeye reports holder shares as fractions (0.42) on this endpoint.
    const pct = n <= 1 ? n * 100 : n;
    return Math.max(0, Math.min(100, pct));
}

function toIsoFromUnix(value: unknown): string | null {
    const n = toFinite(value);
    if (n === null || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function lockedPercent(lockInfo: unknown): number | null {
    if (!lockInfo || typeof lockInfo !== 'object') return null;
    const info = lockInfo as Record<string, unknown>;
    // The endpoint reports one of a few shapes; take the first percentage it offers.
    return toPercent(info.lockedPercent ?? info.locked_percent ?? info.percent ?? null);
}

/**
 * `null` when the payload is unsuccessful or empty. Every field is nullable:
 * absence means unknown and must never be read as "safe".
 */
export function normalizeProviderSecurity(payload: unknown): ProviderSecurity | null {
    if (!payload || typeof payload !== 'object') return null;
    const { success, data } = payload as { success?: unknown; data?: unknown };
    if (success !== true || !data || typeof data !== 'object') return null;
    const sec = data as Record<string, unknown>;

    const freezeAuthority = hasAddress(sec.freezeAuthority);
    const mintAuthority = hasAddress(sec.ownerAddress);
    return {
        top10HoldersPercent: toPercent(sec.top10HolderPercent),
        tokenMintTime: toIsoFromUnix(sec.creationTime ?? sec.mintTime),
        mintable: mintAuthority,
        freezable: toBool(sec.freezeable) ?? freezeAuthority,
        mutableMetadata: toBool(sec.mutableMetadata),
        transferTax: toBool(sec.transferFeeEnable),
        nonTransferable: toBool(sec.nonTransferable),
        isToken2022: toBool(sec.isToken2022),
        lpLockedPercent: lockedPercent(sec.lockInfo),
    };
}

/**
 * Live security facts via Birdeye `/defi/token_security`. Resolves `null`
 * for a mint the provider doesn't know; fails with tagged errors on provider
 * trouble — callers degrade gracefully.
 */
export function fetchProviderSecurity(
    mint: string,
    options: { deadlineMs?: number } = {},
): Effect.Effect<ProviderSecurity | null, unknown> {
    const apiKey = (process.env.BIRDEYE_API_KEY ?? '').trim();
    if (!apiKey) {
        return Effect.fail(new MissingEnvError({ message: 'BIRDEYE_API_KEY is not set', name: 'BIRDEYE_API_KEY' }));
    }

    return fetchJsonWithRetry<unknown>({
        url: `${BIRDEYE_API_URL}/defi/token_security?address=${encodeURIComponent(mint)}`,
        service: 'birdeye',
        init: {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
            cache: 'no-store',
        },
        signal: AbortSignal.timeout(options.deadlineMs ?? 3_500),
        timeout: '2 seconds',
        maxRetries: 1,
        recoverHttpError: error =>
            error.status === 400 || error.status === 404 ? { value: null, outcome: 'not_found' } : null,
    }).pipe(Effect.map(normalizeProviderSecurity));
}
