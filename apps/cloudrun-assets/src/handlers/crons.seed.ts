import { readFileSync } from 'node:fs';

import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';
import type { CanonicalAsset, TrustTier } from '@tokens/asset-registry';
import { listAssets } from '@tokens/asset-registry';
import { ALL_PSEUDO_SLUG, CURATED_LIST_SLUGS, isCuratedListSlug } from '@tokens/asset-registry/curated-lists';
import { CURATED_TOKEN_ADDED_AT } from '@tokens/asset-registry/compat';

import { InvalidArgsError } from './assets';
import type { CronResult } from './crons';

export type AssetAliasKind =
    | 'assetId'
    | 'name'
    | 'symbol'
    | 'ticker'
    | 'coingeckoId'
    | 'alias'
    | 'mint'
    | 'variantId'
    | 'custom';

export interface CanonicalAssetUpsert {
    assetId: string;
    category: string;
    name?: string;
    symbol?: string;
    aliases: string[];
    coingeckoId?: string;
    imageUrl?: string;
    isActive: boolean;
}

export interface CanonicalAssetVariantUpsert {
    assetId: string;
    chain: 'solana';
    mint: string;
    variantId: string;
    kind: string;
    trustTier: TrustTier;
    stockVariantTier?: string;
    tags: readonly string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
    isActive: boolean;
}

export interface CanonicalAssetAliasUpsert {
    assetId: string;
    normalized: string;
    alias: string;
    kind: AssetAliasKind;
    priority: number;
}

export interface CanonicalAssetCollectionUpsert {
    slug: string;
    title: string;
    description: string;
}

export interface CanonicalAssetCollectionMemberUpsert {
    collectionSlug: string;
    assetId: string;
    rank: number;
    /** Unix ms the asset first joined the list (git timestamp when known, else seed time). */
    addedAt: number;
}

export interface IdentityAssetRow {
    assetId: string;
    category: string;
    symbol: string | null;
    name: string | null;
}

export interface IdentityVariantRow {
    assetId: string;
    mint: string;
    variantId: string;
    trustTier: TrustTier;
    label: string | null;
    issuer: string | null;
    tags: string[];
}

export interface IdentityMarketRow {
    mint: string;
    symbol: string | null;
    name: string | null;
}

export interface SetAssetIdentityArgs {
    mint: string;
    symbol?: string;
    name?: string;
    force?: boolean;
}

export interface SeedRepo {
    upsertCanonicalAsset(args: CanonicalAssetUpsert): Promise<void>;
    upsertCanonicalAssetVariant(args: CanonicalAssetVariantUpsert): Promise<void>;
    upsertCanonicalAssetAlias(args: CanonicalAssetAliasUpsert): Promise<void>;
    ensureVariantMarketRow(mint: string): Promise<void>;
    /** INSERT the collection metadata row iff the slug does not exist. */
    insertCollectionIfMissing(args: CanonicalAssetCollectionUpsert): Promise<void>;
    /** INSERT members (source='registry') with ON CONFLICT DO NOTHING; returns rows inserted. */
    insertCollectionMembersIfMissing(members: readonly CanonicalAssetCollectionMemberUpsert[]): Promise<number>;
    /** Total membership rows across the given slugs (fixture-guard check). */
    countCollectionMembers(slugs: readonly string[]): Promise<number>;
    /** Which of the given asset ids are hard-deleted (asset_deletion_tombstones). */
    listTombstonedAssetIds(assetIds: readonly string[]): Promise<string[]>;
    /** Delete a collection row and its membership (one-off 'all' cleanup). Returns rows removed. */
    deleteCollectionCascade(slug: string): Promise<number>;
    /** Which of the given lowercased refs exist in asset_deletion_tombstones. */
    listTombstonedRefs(normalizedRefs: readonly string[]): Promise<string[]>;
    /** Lower (never raise) added_at for every membership of the asset owning the mint. Returns rows updated. */
    lowerCollectionMemberAddedAtByMint(mint: string, addedAtMs: number): Promise<number>;
    refreshSolanaDefaultVariantsView?(): Promise<void>;
    findIdentityAssetsByAssetIds(assetIds: readonly string[]): Promise<IdentityAssetRow[]>;
    findIdentityVariantsByAssetIds(assetIds: readonly string[]): Promise<IdentityVariantRow[]>;
    findIdentityMarketsByMints(mints: readonly string[]): Promise<IdentityMarketRow[]>;
    setAssetIdentityFromMintIfMissing(args: SetAssetIdentityArgs): Promise<void>;
    withTransaction(fn: (txRepo: SeedRepo) => Promise<void>): Promise<void>;
}

export interface BirdeyeIdentityClient {
    fetchIdentityByMint(mint: string): Promise<{ symbol: string | null; name: string | null }>;
}

export interface SeedCronDeps {
    repo: SeedRepo;
    now: () => number;
    listCanonicalAssets?: () => readonly CanonicalAsset[];
    birdeyeIdentity?: BirdeyeIdentityClient;
}

function normalizeAlias(value: string): string {
    return value.trim().toLowerCase();
}

function addAlias(
    out: CanonicalAssetAliasUpsert[],
    seen: Set<string>,
    assetId: string,
    input: { alias: string; kind: AssetAliasKind; priority: number },
): void {
    const alias = input.alias.trim();
    const normalized = normalizeAlias(alias);
    if (!normalized) return;
    const key = `${input.kind}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ assetId, normalized, alias, kind: input.kind, priority: input.priority });
}

export function buildAssetAliases(asset: CanonicalAsset): CanonicalAssetAliasUpsert[] {
    const out: CanonicalAssetAliasUpsert[] = [];
    const seen = new Set<string>();
    addAlias(out, seen, asset.assetId, { alias: asset.assetId, kind: 'assetId', priority: 1000 });
    if (asset.name) addAlias(out, seen, asset.assetId, { alias: asset.name, kind: 'name', priority: 900 });
    if (asset.symbol) addAlias(out, seen, asset.assetId, { alias: asset.symbol, kind: 'symbol', priority: 800 });
    if (asset.coingeckoId) {
        addAlias(out, seen, asset.assetId, { alias: asset.coingeckoId, kind: 'coingeckoId', priority: 700 });
    }
    for (const alias of asset.aliases) {
        addAlias(out, seen, asset.assetId, { alias, kind: 'alias', priority: 600 });
    }
    for (const variant of asset.variants) {
        addAlias(out, seen, asset.assetId, { alias: variant.mint, kind: 'mint', priority: 500 });
        addAlias(out, seen, asset.assetId, { alias: variant.variantId, kind: 'variantId', priority: 475 });
        if (variant.symbol) {
            addAlias(out, seen, asset.assetId, { alias: variant.symbol, kind: 'custom', priority: 300 });
        }
        if (variant.name) {
            addAlias(out, seen, asset.assetId, { alias: variant.name, kind: 'custom', priority: 250 });
        }
        if (variant.label) {
            addAlias(out, seen, asset.assetId, { alias: variant.label, kind: 'custom', priority: 200 });
        }
    }
    return out;
}

/**
 * Candidate tombstone refs for a registry asset, mirroring the normalization
 * in cloudrun-admin's `buildDeletionTombstoneRows` (lowercased assetId, name,
 * symbol, coingeckoId, aliases, mints, and `solana-<mint>` singleton ids).
 */
export function buildRegistryTombstoneRefs(asset: CanonicalAsset): string[] {
    const refs = new Set<string>();
    const add = (value: string | undefined | null) => {
        const normalized = value?.trim().toLowerCase();
        if (normalized) refs.add(normalized);
    };
    add(asset.assetId);
    add(asset.name);
    add(asset.symbol);
    add(asset.coingeckoId);
    for (const alias of asset.aliases) add(alias);
    for (const variant of asset.variants) {
        add(variant.mint);
        add(`solana-${variant.mint}`);
    }
    return [...refs];
}

export async function seedCanonicalAssetsRegistry(
    deps: SeedCronDeps,
    _rawArgs: unknown,
): Promise<CronResult> {
    void _rawArgs;
    const start = deps.now();
    const allRegistryAssets = (deps.listCanonicalAssets ?? listAssets)();

    // Hard-deleted assets must stay dead: skip any registry asset whose refs
    // hit a deletion tombstone, otherwise the nightly seed resurrects it.
    // (Deliberate re-adds go through adminSeedAsset, which clears tombstones.)
    const refsByAssetId = new Map<string, string[]>();
    const allRefs: string[] = [];
    for (const asset of allRegistryAssets) {
        const refs = buildRegistryTombstoneRefs(asset);
        refsByAssetId.set(asset.assetId, refs);
        allRefs.push(...refs);
    }
    const tombstonedRefs = new Set<string>();
    for (const chunk of chunkArray(allRefs, 500)) {
        for (const ref of await deps.repo.listTombstonedRefs(chunk)) tombstonedRefs.add(ref);
    }
    const tombstonedAssetIds = new Set<string>();
    for (const [assetId, refs] of refsByAssetId) {
        if (refs.some(ref => tombstonedRefs.has(ref))) tombstonedAssetIds.add(assetId);
    }
    const assets = allRegistryAssets.filter(asset => !tombstonedAssetIds.has(asset.assetId));

    let assetCount = 0;
    let variantCount = 0;
    let aliasCount = 0;
    let ensuredMarkets = 0;

    for (const asset of assets) {
        await deps.repo.withTransaction(async txRepo => {
            await txRepo.upsertCanonicalAsset({
                assetId: asset.assetId,
                category: asset.category,
                ...(asset.name ? { name: asset.name } : {}),
                ...(asset.symbol ? { symbol: asset.symbol } : {}),
                aliases: [...asset.aliases],
                ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
                isActive: true,
            });

            for (const variant of asset.variants) {
                await txRepo.upsertCanonicalAssetVariant({
                    assetId: asset.assetId,
                    chain: 'solana',
                    mint: variant.mint,
                    variantId: variant.variantId,
                    kind: variant.kind,
                    trustTier: variant.trustTier,
                    ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                    tags: variant.tags,
                    ...(variant.issuer ? { issuer: variant.issuer } : {}),
                    ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                    ...(variant.label ? { label: variant.label } : {}),
                    isActive: true,
                });
                await txRepo.ensureVariantMarketRow(variant.mint);
            }

            for (const alias of buildAssetAliases(asset)) {
                await txRepo.upsertCanonicalAssetAlias(alias);
            }
        });
        assetCount += 1;
        variantCount += asset.variants.length;
        ensuredMarkets += asset.variants.length;
        aliasCount += buildAssetAliases(asset).length;
    }

    // Collection membership is DB-authoritative (admin-edited); the nightly
    // seed maintains registry identity only. Bootstrap for fresh databases:
    // the guarded `seed-curated-collections-fixture` job below.

    if (deps.repo.refreshSolanaDefaultVariantsView) {
        await deps.repo.refreshSolanaDefaultVariantsView();
    }

    return {
        ok: true,
        processed: assetCount,
        durationMs: deps.now() - start,
        assets: assetCount,
        variants: variantCount,
        aliases: aliasCount,
        ensuredMarkets,
        tombstonedSkipped: tombstonedAssetIds.size,
    };
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function looksLikeTicker(value: string): boolean {
    return /^[A-Z0-9]{2,16}$/.test(value.trim().toUpperCase());
}

function getPreferredVariantMint(
    variants: ReadonlyArray<{ mint: string; trustTier: TrustTier }>,
): string | null {
    const rank = (tier: TrustTier): number => {
        if (tier === 'tier1') return 0;
        if (tier === 'tier2') return 1;
        return 2;
    };
    const sorted = [...variants].sort((a, b) => rank(a.trustTier) - rank(b.trustTier));
    return sorted[0]?.mint ?? null;
}

export function deriveFallbackSymbol(asset: CanonicalAsset): string | null {
    if (asset.symbol && looksLikeTicker(asset.symbol)) return asset.symbol.trim().toUpperCase();
    for (const variant of asset.variants) {
        if (variant.symbol && looksLikeTicker(variant.symbol)) return variant.symbol.trim().toUpperCase();
        const label = asNonEmptyString(variant.label);
        if (label) {
            const first = label.split(/[\s(]/)[0]?.trim();
            if (first && looksLikeTicker(first)) return first.toUpperCase();
        }
    }
    const segments = asset.assetId.split(/[^a-z0-9]+/i).filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && looksLikeTicker(last)) return last.toUpperCase();
    for (const alias of asset.aliases) {
        const trimmed = alias.trim();
        if (!trimmed) continue;
        if (looksLikeTicker(trimmed)) return trimmed.toUpperCase();
    }
    return null;
}

export function deriveFallbackName(asset: CanonicalAsset, symbol: string | null): string | null {
    if (asset.name && asset.name.trim() && asset.name.trim().toLowerCase() !== 'unknown') return asset.name.trim();
    for (const variant of asset.variants) {
        const label = asNonEmptyString(variant.label);
        if (label && label.trim().toLowerCase() !== 'unknown') return label;
        if (variant.name && variant.name.trim() && variant.name.trim().toLowerCase() !== 'unknown') {
            return variant.name.trim();
        }
    }
    return symbol;
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

export interface IdentityBackfillResult extends CronResult {
    requested: number;
    updated: number;
    skipped: number;
    failed: number;
    errors: Array<{ assetId: string; message: string }>;
}

export async function backfillMissingAssetIdentity(
    deps: SeedCronDeps,
    rawArgs: unknown,
): Promise<IdentityBackfillResult> {
    const args = (rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {});
    const force = args.force === true;
    const requestedConcurrency = typeof args.concurrency === 'number' ? args.concurrency : 2;
    const concurrency = Math.min(Math.max(Math.floor(requestedConcurrency), 1), 5);
    const requestedDelayMs = typeof args.delayMs === 'number' ? args.delayMs : 150;
    const delayMs = Math.max(Math.floor(requestedDelayMs), 0);

    const start = deps.now();
    const registryAssets = (deps.listCanonicalAssets ?? listAssets)();
    const registryById = new Map(registryAssets.map(asset => [asset.assetId, asset] as const));

    const requestedAssetIdsArg = Array.isArray(args.assetIds)
        ? (args.assetIds as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
    const requestedAssetIds = uniqueStrings(
        requestedAssetIdsArg.length > 0 ? requestedAssetIdsArg : registryAssets.map(a => a.assetId),
    ).slice(0, 500);

    if (requestedAssetIds.length === 0) {
        return {
            ok: true,
            processed: 0,
            durationMs: deps.now() - start,
            requested: 0,
            updated: 0,
            skipped: 0,
            failed: 0,
            errors: [],
        };
    }

    const assetById = new Map<string, IdentityAssetRow>();
    for (const chunk of chunkArray(requestedAssetIds, 250)) {
        const rows = await deps.repo.findIdentityAssetsByAssetIds(chunk);
        for (const row of rows) assetById.set(row.assetId, row);
    }

    const variantsByAssetId = new Map<string, IdentityVariantRow[]>();
    for (const chunk of chunkArray(requestedAssetIds, 250)) {
        const rows = await deps.repo.findIdentityVariantsByAssetIds(chunk);
        for (const row of rows) {
            const list = variantsByAssetId.get(row.assetId) ?? [];
            list.push(row);
            variantsByAssetId.set(row.assetId, list);
        }
    }

    const mints: string[] = [];
    const preferredMintByAssetId = new Map<string, string>();
    for (const assetId of requestedAssetIds) {
        const variants = variantsByAssetId.get(assetId) ?? [];
        const mint = getPreferredVariantMint(variants);
        if (!mint) continue;
        preferredMintByAssetId.set(assetId, mint);
        mints.push(mint);
    }

    const marketIdentityByMint = new Map<string, { symbol: string | null; name: string | null }>();
    for (const chunk of chunkArray(mints, 250)) {
        const rows = await deps.repo.findIdentityMarketsByMints(chunk);
        for (const row of rows) {
            if (!row.symbol && !row.name) continue;
            marketIdentityByMint.set(row.mint, { symbol: row.symbol, name: row.name });
        }
    }

    let updated = 0;
    let skipped = 0;
    const errors: Array<{ assetId: string; message: string }> = [];

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'backfillMissingAssetIdentity',
            items: requestedAssetIds,
            concurrency,
            delayMs,
            shouldStop: isShuttingDown,
            process: assetId =>
                Effect.tryPromise(async () => {
                const asset = assetById.get(assetId);
                const registryAsset = registryById.get(assetId);
                const mint = preferredMintByAssetId.get(assetId);
                if (!asset || !registryAsset || !mint) {
                    skipped += 1;
                    return;
                }
                const hasSymbol = typeof asset.symbol === 'string' && asset.symbol.trim().length > 0;
                const hasName = typeof asset.name === 'string' && asset.name.trim().length > 0;
                if (!force && hasSymbol && hasName) {
                    skipped += 1;
                    return;
                }
                const marketIdentity = marketIdentityByMint.get(mint);
                const marketSymbol = marketIdentity?.symbol ?? null;
                const marketName = marketIdentity?.name ?? null;
                if (marketSymbol || marketName) {
                    await deps.repo.setAssetIdentityFromMintIfMissing({
                        mint,
                        ...(marketSymbol ? { symbol: marketSymbol } : {}),
                        ...(marketName ? { name: marketName } : {}),
                        force,
                    });
                    updated += 1;
                    return;
                }
                if (deps.birdeyeIdentity) {
                    const birdeye = await deps.birdeyeIdentity.fetchIdentityByMint(mint);
                    if (birdeye.symbol || birdeye.name) {
                        await deps.repo.setAssetIdentityFromMintIfMissing({
                            mint,
                            ...(birdeye.symbol ? { symbol: birdeye.symbol } : {}),
                            ...(birdeye.name ? { name: birdeye.name } : {}),
                            force,
                        });
                        updated += 1;
                        return;
                    }
                }
                const fallbackSymbol = deriveFallbackSymbol(registryAsset);
                const fallbackName = deriveFallbackName(registryAsset, fallbackSymbol);
                if (fallbackSymbol || fallbackName) {
                    await deps.repo.setAssetIdentityFromMintIfMissing({
                        mint,
                        ...(fallbackSymbol ? { symbol: fallbackSymbol } : {}),
                        ...(fallbackName ? { name: fallbackName } : {}),
                        force,
                    });
                    updated += 1;
                    return;
                }
                skipped += 1;
                }),
            onItemError: (assetId, error) =>
                Effect.sync(() => {
                    errors.push({
                        assetId,
                        message: error instanceof Error ? error.message : String(error),
                    });
                }),
        }),
    );

    return {
        ok: !(summary.attempted > 0 && updated === 0 && skipped === 0 && summary.failed >= summary.attempted),
        processed: requestedAssetIds.length,
        durationMs: deps.now() - start,
        requested: requestedAssetIds.length,
        updated,
        skipped,
        failed: summary.failed,
        errors: errors.slice(0, 100),
        ...(summary.partial ? { partial: true } : {}),
    };
}

/**
 * One-time, idempotent backfill: replace seed-stamped `added_at` values with
 * the git-history timestamps from `CURATED_TOKEN_ADDED_AT`. Only ever lowers
 * a value — admin-stamped and already-correct timestamps are left alone.
 * On-demand via `POST /jobs/backfill-curated-added-at`; no scheduler entry.
 */
export async function backfillCuratedAddedAt(deps: SeedCronDeps, _rawArgs: unknown): Promise<CronResult> {
    void _rawArgs;
    const start = deps.now();
    let mintsProcessed = 0;
    let rowsLowered = 0;
    for (const [mint, addedAtMs] of Object.entries(CURATED_TOKEN_ADDED_AT)) {
        if (!Number.isFinite(addedAtMs)) continue;
        rowsLowered += await deps.repo.lowerCollectionMemberAddedAtByMint(mint, addedAtMs);
        mintsProcessed += 1;
    }
    return {
        ok: true,
        processed: mintsProcessed,
        durationMs: deps.now() - start,
        rowsLowered,
    };
}

interface CuratedFixtureMember {
    assetId: string;
    rank: number;
    addedAtMs: number;
}

interface CuratedFixtureCollection {
    slug: string;
    title: string;
    description: string;
    members: CuratedFixtureMember[];
}

const RECOVERY_CONFIRMATION = 'RESEED_CURATED_COLLECTIONS';

function loadCuratedCollectionsFixture(): CuratedFixtureCollection[] {
    const raw = readFileSync(new URL('../data/curated-collections-seed.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as CuratedFixtureCollection[];
    if (!Array.isArray(parsed)) throw new Error('curated-collections-seed.json: expected an array');
    for (const collection of parsed) {
        if (!isCuratedListSlug(collection.slug)) {
            throw new Error(`curated-collections-seed.json: unknown slug ${collection.slug}`);
        }
    }
    return parsed;
}

/**
 * One-off, guarded bootstrap of `asset_collections(_members)` from the frozen
 * fixture (generated once from the compiled registry arrays + git added-at
 * map — see scripts/generate-curated-collections-fixture.ts).
 *
 * The DB is the membership authority, so a rerun against an edited database
 * must NOT silently resurrect admin-deleted members:
 * - bootstrap (default): fails before writing unless the seven curated
 *   collections have zero membership rows.
 * - recovery: explicit `{ mode: 'recovery', confirm: 'RESEED_CURATED_COLLECTIONS' }`
 *   inserts any missing baseline rows (never overwrites existing ones).
 */
export async function seedCuratedCollectionsFixture(deps: SeedCronDeps, rawArgs: unknown): Promise<CronResult> {
    const start = deps.now();
    const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
    const mode = args.mode === 'recovery' ? 'recovery' : 'bootstrap';
    if (args.mode !== undefined && args.mode !== 'recovery' && args.mode !== 'bootstrap') {
        throw new InvalidArgsError(`mode must be 'bootstrap' or 'recovery'`);
    }
    if (mode === 'recovery' && args.confirm !== RECOVERY_CONFIRMATION) {
        throw new InvalidArgsError(`recovery mode requires confirm: '${RECOVERY_CONFIRMATION}'`);
    }

    const existingMembers = await deps.repo.countCollectionMembers(CURATED_LIST_SLUGS);
    if (mode === 'bootstrap' && existingMembers > 0) {
        return {
            ok: false,
            processed: 0,
            durationMs: deps.now() - start,
            error: 'collections_not_empty',
            existingMembers,
            hint: `curated collections already have membership; use { mode: 'recovery', confirm: '${RECOVERY_CONFIRMATION}' } to insert missing baseline rows`,
        };
    }

    const fixture = loadCuratedCollectionsFixture();
    const fixtureAssetIds = [...new Set(fixture.flatMap(c => c.members.map(m => m.assetId)))];
    const tombstoned = new Set<string>();
    for (const chunk of chunkArray(fixtureAssetIds, 500)) {
        for (const assetId of await deps.repo.listTombstonedAssetIds(chunk)) tombstoned.add(assetId);
    }

    let collectionsProcessed = 0;
    let membersInserted = 0;
    let tombstonedSkipped = 0;
    await deps.repo.withTransaction(async txRepo => {
        for (const collection of fixture) {
            await txRepo.insertCollectionIfMissing({
                slug: collection.slug,
                title: collection.title,
                description: collection.description,
            });
            collectionsProcessed += 1;
            const members: CanonicalAssetCollectionMemberUpsert[] = [];
            for (const member of collection.members) {
                if (tombstoned.has(member.assetId)) {
                    tombstonedSkipped += 1;
                    continue;
                }
                members.push({
                    collectionSlug: collection.slug,
                    assetId: member.assetId,
                    rank: member.rank,
                    addedAt: member.addedAtMs,
                });
            }
            membersInserted += await txRepo.insertCollectionMembersIfMissing(members);
        }
    });

    return {
        ok: true,
        processed: collectionsProcessed,
        durationMs: deps.now() - start,
        mode,
        membersInserted,
        tombstonedSkipped,
    };
}

/**
 * One-off cleanup: the 'all' pseudo-list is a live union now (never
 * persisted), so the materialized rows the old nightly seed maintained are
 * dead weight. Idempotent; run only after live-union reads are verified.
 */
export async function cleanupMaterializedAllCollection(deps: SeedCronDeps, _rawArgs: unknown): Promise<CronResult> {
    void _rawArgs;
    const start = deps.now();
    const removed = await deps.repo.deleteCollectionCascade(ALL_PSEUDO_SLUG);
    return { ok: true, processed: removed, durationMs: deps.now() - start, rowsRemoved: removed };
}

export type SeedJobHandler = (deps: SeedCronDeps, args: unknown) => Promise<CronResult>;

export const seedJobs: Record<string, SeedJobHandler> = {
    'seed-canonical-assets-registry': seedCanonicalAssetsRegistry,
    'backfill-missing-asset-identity': backfillMissingAssetIdentity,
    'backfill-curated-added-at': backfillCuratedAddedAt,
    'seed-curated-collections-fixture': seedCuratedCollectionsFixture,
    'cleanup-materialized-all-collection': cleanupMaterializedAllCollection,
};
