import { Effect } from 'effect';

import { NotFoundError, tapErrorAndDefault } from '@tokens/effect';
import {
    assetVariantsGetByMint,
    assetVariantsListByMints,
    launchpadApprovedMints,
    sanctumListActive,
    sanctumResolveRef,
    type AssetVariantsGetByMintResult,
} from '@/lib/cloudrun';
import { listDeletedRefs } from '@/lib/deleted-refs';
import { getVariantByMint } from '@tokens/asset-registry';

/**
 * v1 serves admin-registered assets only.
 *
 * A Solana mint is *registered* when any of these holds, checked in order:
 *   1. `db`       — an active `asset_variants` row whose asset is active (the
 *                   admin app's tables; asset ids may be slugs, raw mints or
 *                   `solana-<mint>`, all of them registered);
 *   2. `registry` — the compiled `@tokens/asset-registry` knows the mint and the
 *                   asset is not tombstoned;
 *   3. `sanctum`  — a Sanctum LST, which resolves to the `solana` asset;
 *   4. `launch`   — an admin-approved launch coin still active in the feed
 *                   (approval never creates an `assets` row, so this is what
 *                   keeps a stonk.fun coin's `solana-<mint>` page alive).
 * Anything else is `unregistered` and every v1 route answers 404
 * `asset_not_registered`. Adding a new source means adding a tier here; every
 * route goes through this module.
 *
 * Fail-open: when the registry lookups themselves fail (Cloud Run blip), the
 * mint is classified `unavailable` and the caller falls back to the behaviour
 * it had before this rule, so an outage never turns registered assets into
 * 404s. The "Defaulting after effect error" log line feeds the degraded-
 * responses alert.
 *
 * Kill switch: `TOKENS_V1_REGISTERED_ONLY=off` restores the pre-rule behaviour
 * (singleton synthesis for unknown mints) everywhere.
 */
export function v1RegisteredOnlyEnabled(): boolean {
    return process.env.TOKENS_V1_REGISTERED_ONLY?.trim().toLowerCase() !== 'off';
}

export const ASSET_NOT_REGISTERED_CODE = 'asset_not_registered';
export const ASSET_NOT_REGISTERED_HINT =
    'v1 serves registered assets only. To track other tokens, add them to a token list (POST /v2/lists, then PUT /v2/lists/{slug}/members/{mint}) and read them with GET /v2/lists/tokens?lists={slug}.';

export function unregisteredMintError(mint: string): NotFoundError {
    return new NotFoundError({
        message: 'Asset not registered',
        resource: 'asset',
        details: { code: ASSET_NOT_REGISTERED_CODE, mint, hint: ASSET_NOT_REGISTERED_HINT },
    });
}

export type RegisteredVariant = NonNullable<AssetVariantsGetByMintResult>;
export type RegistryMatch = NonNullable<ReturnType<typeof getVariantByMint>>;

export type MintClassification =
    | { kind: 'db'; variant: RegisteredVariant }
    | { kind: 'registry'; match: RegistryMatch }
    | { kind: 'sanctum' }
    | { kind: 'launch' }
    | { kind: 'unregistered' }
    /** A lookup failed; treat as registered (fail-open) and let the caller continue as before. */
    | { kind: 'unavailable' };

export type IsDeletedRef = (ref: string) => Effect.Effect<boolean, never>;

function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/** After a 404 from an older assets service without the handler, skip the launch tier for a while. */
const LAUNCH_TIER_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
let launchTierUnavailableUntilMs = 0;

/** Test hook. */
export function __resetRegisteredOnlyForTests(): void {
    launchTierUnavailableUntilMs = 0;
}

/** The assets service considers at most this many mints per `launchpadApprovedMints` call. */
const LAUNCH_RPC_CHUNK = 500;

/** `null` = the lookup failed (fail open upstream); otherwise the approved subset. */
function approvedLaunchMints(mints: readonly string[]): Effect.Effect<Set<string> | null, never> {
    if (mints.length === 0) return Effect.succeed(new Set<string>());
    if (Date.now() < launchTierUnavailableUntilMs) return Effect.succeed(new Set<string>());
    return Effect.gen(function* () {
        const approved = new Set<string>();
        for (const part of chunk(mints, LAUNCH_RPC_CHUNK)) {
            if (Date.now() < launchTierUnavailableUntilMs) break;
            const result = yield* launchpadApprovedMints({ mints: [...part] }).pipe(
                Effect.map(r => r.mints),
                Effect.catch(error => {
                    const tagged = error as { _tag?: string; status?: number };
                    if (tagged._tag === 'CloudRunHttpError' && tagged.status === 404) {
                        // Older server: the tier does not exist yet, which is a miss, not an outage.
                        launchTierUnavailableUntilMs = Date.now() + LAUNCH_TIER_UNAVAILABLE_BACKOFF_MS;
                        return Effect.succeed([] as string[]);
                    }
                    return Effect.succeed(null);
                }),
            );
            if (result === null) return null;
            for (const mint of result) approved.add(mint);
        }
        return approved;
    });
}

/**
 * Classify one mint. `dbVariant` lets a caller that already fetched the
 * variant row (or saw the lookup fail) skip the first RPC.
 */
export function classifyMint(
    mint: string,
    isDeletedRef: IsDeletedRef,
    options: { dbVariant?: RegisteredVariant | null | 'error' } = {},
): Effect.Effect<MintClassification, never> {
    return Effect.gen(function* () {
        const db =
            options.dbVariant !== undefined
                ? options.dbVariant
                : yield* assetVariantsGetByMint({ mint }).pipe(
                      tapErrorAndDefault('assets.registeredOnly.variantByMint', 'error' as const, { mint }),
                  );
        const dbFailed = db === 'error';
        if (!dbFailed && db) return { kind: 'db', variant: db } as const;

        const match = getVariantByMint(mint);
        if (match) {
            const deleted = yield* isDeletedRef(match.asset.coingeckoId ?? match.asset.assetId);
            if (!deleted) return { kind: 'registry', match } as const;
        }

        const sanctum = yield* sanctumResolveRef({ ref: mint }).pipe(
            tapErrorAndDefault('assets.registeredOnly.sanctumMintRef', 'error' as const, { mint }),
        );
        const sanctumFailed = sanctum === 'error';
        if (!sanctumFailed && sanctum) return { kind: 'sanctum' } as const;

        const approved = yield* approvedLaunchMints([mint]);
        if (approved?.has(mint)) return { kind: 'launch' } as const;

        // Any tier that could not answer leaves the mint possibly registered: fail open.
        if (dbFailed || sanctumFailed || approved === null) return { kind: 'unavailable' } as const;
        return { kind: 'unregistered' } as const;
    });
}

/** True unless the mint is positively unregistered (fail-open on lookup errors). */
export function isRegisteredMint(mint: string, isDeletedRef: IsDeletedRef): Effect.Effect<boolean, never> {
    return classifyMint(mint, isDeletedRef).pipe(Effect.map(c => c.kind !== 'unregistered'));
}

function memoisedDeletedRefChecker(): IsDeletedRef {
    const cache = new Map<string, boolean>();
    return ref =>
        Effect.gen(function* () {
            const normalized = ref.trim().toLowerCase();
            if (!normalized) return false;
            const cached = cache.get(normalized);
            if (cached !== undefined) return cached;
            const deleted = yield* listDeletedRefs({ refs: [normalized] }).pipe(
                Effect.catch(() => Effect.succeed([] as string[])),
            );
            const isDeleted = deleted.includes(normalized);
            cache.set(normalized, isDeleted);
            return isDeleted;
        });
}

/** `isRegisteredMint` with a fresh tombstone cache, for routes that have none. */
export function isRegisteredMintStandalone(mint: string): Effect.Effect<boolean, never> {
    return isRegisteredMint(mint, memoisedDeletedRefChecker());
}

const BATCH_CHUNK = 250;

/**
 * Batch form for the list routes: which of `mints` are registered, by the same
 * four tiers, each tier consulted only for mints the previous ones missed.
 * Input order is preserved in both outputs. A failed DB, Sanctum or launch
 * lookup fails open (every mint counted as registered), matching `classifyMint`.
 */
export function partitionRegisteredMints(
    mints: readonly string[],
): Effect.Effect<{ registered: string[]; unregistered: string[] }, never> {
    return Effect.gen(function* () {
        if (mints.length === 0) return { registered: [], unregistered: [] };
        const registered = new Set<string>();

        // 1. DB variants (chunked; the server caps at 250 per call).
        const rowsByChunk = yield* Effect.all(
            chunk(mints, BATCH_CHUNK).map(part =>
                assetVariantsListByMints({ mints: part }).pipe(
                    tapErrorAndDefault('assets.registeredOnly.variantsByMints', null, { count: part.length }),
                ),
            ),
            { concurrency: 4 },
        );
        if (rowsByChunk.some(rows => rows === null)) {
            return { registered: [...mints], unregistered: [] };
        }
        for (const rows of rowsByChunk) for (const row of rows ?? []) if (row.variant) registered.add(row.mint);

        // 2. Compiled registry, minus tombstoned assets (one memoised lookup for the hits).
        const registryHits = new Map<string, string>(); // mint → tombstone ref
        for (const mint of mints) {
            if (registered.has(mint)) continue;
            const match = getVariantByMint(mint);
            if (match) registryHits.set(mint, (match.asset.coingeckoId ?? match.asset.assetId).trim().toLowerCase());
        }
        if (registryHits.size > 0) {
            const deleted = new Set(
                yield* listDeletedRefs({ refs: Array.from(new Set(registryHits.values())) }).pipe(
                    Effect.catch(() => Effect.succeed([] as string[])),
                ),
            );
            for (const [mint, ref] of registryHits) if (!deleted.has(ref)) registered.add(mint);
        }

        // 3. Sanctum LSTs — one list read, only if something is still unresolved.
        let remaining = mints.filter(mint => !registered.has(mint));
        if (remaining.length > 0) {
            const lsts = yield* sanctumListActive({}).pipe(
                tapErrorAndDefault('assets.registeredOnly.sanctumList', null, {}),
            );
            // A failed list read leaves every remaining mint possibly registered: fail open.
            if (lsts === null) return { registered: [...mints], unregistered: [] };
            const lstMints = new Set(lsts.map(entry => entry.mint));
            for (const mint of remaining) if (lstMints.has(mint)) registered.add(mint);
            remaining = mints.filter(mint => !registered.has(mint));
        }

        // 4. Admin-approved launch coins.
        if (remaining.length > 0) {
            const approved = yield* approvedLaunchMints(remaining);
            if (approved === null) return { registered: [...mints], unregistered: [] };
            for (const mint of remaining) if (approved.has(mint)) registered.add(mint);
        }

        return {
            registered: mints.filter(mint => registered.has(mint)),
            unregistered: mints.filter(mint => !registered.has(mint)),
        };
    });
}
