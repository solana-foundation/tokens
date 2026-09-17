/**
 * Admin lookups for the Launches page, served from cloudrun-assets because
 * this service owns the stonk.fun client. Read-only: they never write; the
 * approval itself is `approveLaunchpadMint` on cloudrun-admin.
 *
 * - `adminPreviewLaunchpadMint`: the "Check mint" step — what the coin is,
 *   which asset page it would land on, and its sync/approval state.
 * - `adminListLaunchpadTokensForQuote`: every graduated coin stonk.fun has
 *   for an asset's quote mints, including sub-threshold coins the sync never
 *   stores, so admins can see the complete list before approving.
 */

import { getCanonicalFallbackLogoPath } from '@tokens/asset-registry';

import { requireAdmin, type AdminAllowlist } from '../adminAuth';
import { InvalidArgsError, type CallerIdentity } from './assets';
import { birdeyeOverviewToUpsert, type BirdeyeClient, type JobsRepo } from './crons';
import { birdeyeOverviewToTokenUpsert } from './crons.misc';
import {
    STONKFUN_LAUNCHPAD,
    launchpadTokenToUpsert,
    parseLaunchpadSyncArgs,
    passesThreshold,
    type LaunchpadJobsRepo,
    type StonkfunClient,
    type StonkfunPair,
    type StonkfunToken,
    type StonkfunTokenMarket,
} from './crons.launchpad';
import type { CuratedMembershipSource } from './curatedMembershipReads';

export interface LaunchpadAdminDeps {
    adminAllowlist: AdminAllowlist;
    stonkfun: StonkfunClient;
    repo: Pick<
        LaunchpadJobsRepo,
        | 'listSyncedStates'
        | 'findApproval'
        | 'findQuoteAssetByMint'
        | 'filterMintsKnownTokens'
        | 'filterMintsWithVariantMarket'
        | 'upsertTokenFromBirdeye'
        | 'upsertLaunchpadTokenLatest'
    >;
    curated: Pick<CuratedMembershipSource, 'getAllCuratedMintsInOrder'>;
    /** Present when Birdeye is configured; lets "sync now" fetch identity for a brand-new coin. */
    identity?: { birdeye: BirdeyeClient; baseRepo: Pick<JobsRepo, 'upsertVariantMarketFromBirdeye'> };
    now: () => number;
}

/** A curated asset that stonk.fun accepts as a quote token, i.e. a row on the Launches page. */
export interface LaunchpadPairAsset {
    assetId: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    quoteMints: Array<{ mint: string; symbol: string | null; category: string | null }>;
}

export interface ListLaunchpadPairsResult {
    fetchedAt: number;
    /** Launchable stonk.fun pairs, total and how many map to a curated asset. */
    pairsTotal: number;
    curatedPairs: number;
    assets: LaunchpadPairAsset[];
}

export interface SyncLaunchpadMintResult {
    mint: string;
    synced: boolean;
    isActive: boolean;
    /** Why it could not be stored / activated, when applicable. */
    reason: 'not_found' | 'not_graduated' | 'quote_not_curated' | 'identity_pending' | null;
}

export interface LaunchpadTokenSummary {
    mint: string;
    symbol: string | null;
    name: string | null;
    imageUrl: string | null;
    status: string | null;
    launchpad: string | null;
    mode: string | null;
    quoteMint: string;
    quoteSymbol: string | null;
    market: StonkfunTokenMarket;
    createdAt: number | null;
    graduatedAt: number | null;
}

export interface LaunchpadMintPreview {
    mint: string;
    checkedAt: number;
    found: boolean;
    token: LaunchpadTokenSummary | null;
    quote: {
        mint: string;
        symbol: string | null;
        curated: boolean;
        asset: { assetId: string; symbol: string | null; name: string | null; imageUrl: string | null } | null;
    } | null;
    synced: boolean;
    isActive: boolean;
    approved: { note: string | null; approvedAt: number } | null;
    meetsThreshold: boolean;
    warnings: string[];
}

export interface LaunchpadQuoteTokenRow extends LaunchpadTokenSummary {
    synced: boolean;
    isActive: boolean;
    approved: { note: string | null; approvedAt: number } | null;
    meetsThreshold: boolean;
}

export interface ListLaunchpadTokensForQuoteResult {
    quoteMints: string[];
    fetchedAt: number;
    tokens: LaunchpadQuoteTokenRow[];
}

const MAX_QUOTE_MINTS = 25;
const MAX_TOKENS = 500;
const DEFAULT_MAX_PAGES = 5;

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function requireMint(obj: Record<string, unknown>, key: string): string {
    const value = obj[key];
    if (typeof value !== 'string') throw new InvalidArgsError(`${key} is required`);
    const mint = value.trim();
    if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError(`${key} must be a base58 Solana mint address`);
    return mint;
}

function requireMintArray(obj: Record<string, unknown>, key: string): string[] {
    const raw = obj[key];
    if (!Array.isArray(raw) || raw.length === 0) throw new InvalidArgsError(`${key} must be a non-empty array`);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of raw) {
        if (typeof value !== 'string') throw new InvalidArgsError(`${key} must contain strings`);
        const mint = value.trim();
        if (!looksLikeSolanaMintAddress(mint)) throw new InvalidArgsError(`${key} must contain base58 mint addresses`);
        if (seen.has(mint)) continue;
        seen.add(mint);
        out.push(mint);
        if (out.length > MAX_QUOTE_MINTS)
            throw new InvalidArgsError(`${key} must have at most ${MAX_QUOTE_MINTS} mints`);
    }
    return out;
}

function readMaxPages(obj: Record<string, unknown>): number {
    const value = obj.maxPages;
    if (value === undefined) return DEFAULT_MAX_PAGES;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidArgsError('maxPages must be a number');
    return Math.min(Math.max(Math.floor(value), 1), 30);
}

export function toTokenSummary(token: StonkfunToken): LaunchpadTokenSummary {
    return {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        imageUrl: token.imageUrl,
        status: token.status,
        launchpad: token.launchpad,
        mode: token.mode,
        quoteMint: token.quoteMint,
        quoteSymbol: token.quoteSymbol,
        market: token.market,
        createdAt: token.createdAt,
        graduatedAt: token.graduatedAt,
    };
}

function providerFailureMessage(result: { reason: string; status?: number; message?: string }): string {
    if (result.reason === 'http_error') return `stonk.fun responded with HTTP ${result.status ?? '?'}`;
    if (result.reason === 'invalid_payload') return 'stonk.fun returned an unexpected payload';
    return `stonk.fun request failed${result.message ? `: ${result.message}` : ''}`;
}

export async function adminPreviewLaunchpadMint(
    deps: LaunchpadAdminDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<LaunchpadMintPreview> {
    requireAdmin(deps.adminAllowlist, identity);
    const args = asObject(rawArgs);
    const mint = requireMint(args, 'mint');
    const checkedAt = deps.now();
    const threshold = parseLaunchpadSyncArgs({});

    const [fetched, syncedStates, approved] = await Promise.all([
        deps.stonkfun.fetchToken(mint),
        deps.repo.listSyncedStates(STONKFUN_LAUNCHPAD, [mint]),
        deps.repo.findApproval(STONKFUN_LAUNCHPAD, mint),
    ]);
    if (!fetched.ok) throw new InvalidArgsError(providerFailureMessage(fetched));

    const token = fetched.items[0] ?? null;
    const synced = syncedStates.get(mint) ?? null;
    const warnings: string[] = [];

    if (!token) {
        warnings.push('stonk.fun does not know this mint; it will never be synced.');
        return {
            mint,
            checkedAt,
            found: false,
            token: null,
            quote: null,
            synced: synced !== null,
            isActive: synced?.isActive ?? false,
            approved,
            meetsThreshold: false,
            warnings,
        };
    }

    const curatedMints = new Set(deps.curated.getAllCuratedMintsInOrder());
    const quoteCurated = curatedMints.has(token.quoteMint);
    const quoteAsset = quoteCurated ? await deps.repo.findQuoteAssetByMint(token.quoteMint) : null;
    const meetsThreshold = passesThreshold(token, threshold);

    if (token.status !== 'graduated') {
        warnings.push(
            `Not graduated yet (status: ${token.status ?? 'unknown'}); the sync only stores graduated coins.`,
        );
    }
    if (!quoteCurated) {
        warnings.push(
            `Quote token ${token.quoteSymbol ?? token.quoteMint} is not a curated asset, so this coin has no page to appear on.`,
        );
    } else if (!quoteAsset) {
        warnings.push('Quote token is curated but no canonical asset owns it in the database.');
    }
    if (!meetsThreshold) {
        warnings.push(
            `Below the sync threshold ($${threshold.minMarketCapUsd.toLocaleString()} market cap or $${threshold.minVolume24hUsd.toLocaleString()} 24h volume); it is stored only while approved.`,
        );
    }
    if (synced && !synced.isActive) {
        warnings.push(
            'Synced but not live yet: token identity is still pending from Birdeye or it was missing from the last sync.',
        );
    }
    if (approved) warnings.push('Already approved; approving again only updates the note.');

    return {
        mint,
        checkedAt,
        found: true,
        token: toTokenSummary(token),
        quote: {
            mint: token.quoteMint,
            symbol: token.quoteSymbol,
            curated: quoteCurated,
            asset: quoteAsset,
        },
        synced: synced !== null,
        isActive: synced?.isActive ?? false,
        approved,
        meetsThreshold,
        warnings,
    };
}

export async function adminListLaunchpadTokensForQuote(
    deps: LaunchpadAdminDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<ListLaunchpadTokensForQuoteResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const args = asObject(rawArgs);
    const quoteMints = requireMintArray(args, 'quoteMints');
    const maxPages = readMaxPages(args);
    const fetchedAt = deps.now();
    const threshold = parseLaunchpadSyncArgs({});

    const byMint = new Map<string, StonkfunToken>();
    for (const quoteMint of quoteMints) {
        const result = await deps.stonkfun.fetchGraduatedTokensByQuote(quoteMint, { maxPages });
        if (!result.ok) throw new InvalidArgsError(providerFailureMessage(result));
        for (const token of result.items) {
            if (token.quoteMint !== quoteMint) continue;
            if (!byMint.has(token.mint)) byMint.set(token.mint, token);
        }
    }

    const tokens = [...byMint.values()]
        .sort(
            (a, b) =>
                (b.market.marketCapUsd ?? 0) - (a.market.marketCapUsd ?? 0) ||
                (b.market.volume24hUsd ?? 0) - (a.market.volume24hUsd ?? 0) ||
                a.mint.localeCompare(b.mint),
        )
        .slice(0, MAX_TOKENS);
    const mints = tokens.map(t => t.mint);
    const syncedStates = await deps.repo.listSyncedStates(STONKFUN_LAUNCHPAD, mints);
    const approvals = await Promise.all(mints.map(mint => deps.repo.findApproval(STONKFUN_LAUNCHPAD, mint)));

    return {
        quoteMints,
        fetchedAt,
        tokens: tokens.map((token, i) => {
            const synced = syncedStates.get(token.mint) ?? null;
            return {
                ...toTokenSummary(token),
                synced: synced !== null,
                isActive: synced?.isActive ?? false,
                approved: approvals[i] ?? null,
                meetsThreshold: passesThreshold(token, threshold),
            };
        }),
    };
}

/**
 * Cross-reference: every launchable stonk.fun pair whose mint is one of our
 * curated mints, grouped by the canonical asset that owns it. These are the
 * rows of the Launches page even before any coin exists for them.
 */
export async function adminListLaunchpadPairs(
    deps: LaunchpadAdminDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<ListLaunchpadPairsResult> {
    requireAdmin(deps.adminAllowlist, identity);
    asObject(rawArgs);
    const fetchedAt = deps.now();
    const result = await deps.stonkfun.fetchPairs();
    if (!result.ok) throw new InvalidArgsError(providerFailureMessage(result));

    const curatedMints = new Set(deps.curated.getAllCuratedMintsInOrder());
    const curated: StonkfunPair[] = result.pairs.filter(pair => pair.launchable && curatedMints.has(pair.mint));

    const byAsset = new Map<string, LaunchpadPairAsset>();
    for (const pair of curated) {
        const asset = await deps.repo.findQuoteAssetByMint(pair.mint);
        if (!asset) continue;
        let entry = byAsset.get(asset.assetId);
        if (!entry) {
            entry = {
                assetId: asset.assetId,
                symbol: asset.symbol,
                name: asset.name,
                imageUrl:
                    (asset.imageUrl ?? '').trim() ||
                    getCanonicalFallbackLogoPath({ assetId: asset.assetId, symbol: asset.symbol, name: asset.name }) ||
                    null,
                quoteMints: [],
            };
            byAsset.set(asset.assetId, entry);
        }
        entry.quoteMints.push({ mint: pair.mint, symbol: pair.symbol, category: pair.category });
    }

    const assets = [...byAsset.values()].sort((a, b) =>
        (a.symbol ?? a.assetId).localeCompare(b.symbol ?? b.assetId, undefined, { sensitivity: 'base' }),
    );
    return { fetchedAt, pairsTotal: result.pairs.length, curatedPairs: curated.length, assets };
}

/**
 * "Sync now" for one coin, so an approval shows up under its asset without
 * waiting for the 15-minute cron: fetch it from stonk.fun, ensure identity
 * (Birdeye) when missing, and upsert the launchpad row. Approval itself is
 * not checked here; the read path's JOIN still gates what goes public.
 */
export async function adminSyncLaunchpadMint(
    deps: LaunchpadAdminDeps,
    rawArgs: unknown,
    identity: CallerIdentity | null,
): Promise<SyncLaunchpadMintResult> {
    requireAdmin(deps.adminAllowlist, identity);
    const args = asObject(rawArgs);
    const mint = requireMint(args, 'mint');
    const now = deps.now();

    const fetched = await deps.stonkfun.fetchToken(mint);
    if (!fetched.ok) throw new InvalidArgsError(providerFailureMessage(fetched));
    const token = fetched.items[0];
    if (!token) return { mint, synced: false, isActive: false, reason: 'not_found' };
    if (token.status !== 'graduated') return { mint, synced: false, isActive: false, reason: 'not_graduated' };
    if (!new Set(deps.curated.getAllCuratedMintsInOrder()).has(token.quoteMint)) {
        return { mint, synced: false, isActive: false, reason: 'quote_not_curated' };
    }

    const [known, withMarket] = await Promise.all([
        deps.repo.filterMintsKnownTokens([mint]),
        deps.repo.filterMintsWithVariantMarket([mint]),
    ]);
    let hasIdentity = known.length > 0 && withMarket.length > 0;
    if (!hasIdentity && deps.identity) {
        const overview = await deps.identity.birdeye.fetchTokenOverview(mint);
        const tokenUpsert = overview
            ? birdeyeOverviewToTokenUpsert(mint, overview as unknown as Record<string, unknown>, now)
            : null;
        const marketUpsert = overview ? birdeyeOverviewToUpsert(mint, overview, now) : null;
        if (tokenUpsert && marketUpsert) {
            await deps.repo.upsertTokenFromBirdeye(tokenUpsert);
            await deps.identity.baseRepo.upsertVariantMarketFromBirdeye(marketUpsert);
            hasIdentity = true;
        }
    }

    // Rank after everything the cron stored; the next run re-ranks by activity.
    await deps.repo.upsertLaunchpadTokenLatest(launchpadTokenToUpsert(token, 1_000_000, hasIdentity, now));
    return { mint, synced: true, isActive: hasIdentity, reason: hasIdentity ? null : 'identity_pending' };
}
