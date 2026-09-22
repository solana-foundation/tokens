import { Effect } from 'effect';
import { isShuttingDown } from '@tokens/cloudrun-shutdown';
import { runJobPool } from '@tokens/effect/job-runner';

import type { CronDeps, CronResult } from './crons';
import { InvalidArgsError } from './crons';
import { fetchLogoBytes, LOGO_MAX_BYTES, type ResolveHost } from './logoFetch';
import { LOGO_OUTPUT_CONTENT_TYPE, sniffImageContentType, type LogoNormalizer } from './logoImage';
import {
    buildDirectAttempts,
    buildFetchPlan,
    extractJupiterIcon,
    isFirstPartyLogoUrl,
    isIpfsSourceUrl,
    sha256Hex,
    type FetchAttempt,
    type FetchPlanConfig,
    type LogoSourceKind,
} from './logoSource';
import type { LogoStore } from '../logoStore';

// logo-sync: re-host token artwork so `logoURI` never points at a public IPFS
// gateway (429/403 for everyone) or an SVG native decoders cannot render.
// Per candidate mint: walk the fetch plan (our Pinata gateway for IPFS refs,
// the origin unless it is a public gateway, dexscreener, Jupiter), sniff the
// real content type, rasterise/resize to 256px WebP, upload to the public GCS
// bucket at `solana/<mint>.webp`, and record the result in `mint_logos`
// (migration 0023). Readers resolve `mint_logos.logo_cdn_url` over `logo_uri`.

export const LOGO_OBJECT_PREFIX = 'solana';
export const LOGO_CACHE_CONTROL = 'public, max-age=86400';

export interface LogoSyncCandidate {
    mint: string;
    /** Best current raw logo URL for the mint. */
    source_url: string;
    source_table: string | null;
    /** Stored state from `mint_logos` (null when the mint has never been attempted). */
    logo_source_hash: string | null;
    logo_cdn_url: string | null;
    /** Unix ms. */
    logo_synced_at: number | null;
    attempts: number;
}

export interface ListLogoSyncCandidatesArgs {
    /** Curated universe in cron order; ranked first. */
    curatedMints: readonly string[];
    /** Restrict to these mints (explicit targets). */
    mints?: readonly string[];
    limit: number;
    nowMs: number;
    /** Rows synced before this are eligible for a periodic re-sync. */
    resyncBeforeMs: number;
    /** Non-curated mints qualify only when fetched since this (unix ms). */
    tailSinceMs: number;
    /** Ignore the unchanged-skip and failure backoff. */
    force: boolean;
    /** Never re-host URLs under this prefix (our own copies). */
    publicBaseUrl: string;
}

export interface LogoSyncSuccess {
    mint: string;
    sourceUrl: string;
    sourceTable: string | null;
    sourceKind: LogoSourceKind;
    sourceHash: string;
    cdnUrl: string;
    contentType: string;
    nowMs: number;
}

export interface LogoSyncFailure {
    mint: string;
    sourceUrl: string;
    sourceTable: string | null;
    error: string;
    nowMs: number;
}

export interface LogoSyncRepo {
    listCandidates(args: ListLogoSyncCandidatesArgs): Promise<LogoSyncCandidate[]>;
    /** Upsert; resets `attempts`, sets `logo_cdn_url` + `logo_synced_at`. */
    recordSuccess(row: LogoSyncSuccess): Promise<void>;
    /** Upsert; increments `attempts`, keeps any previous `logo_cdn_url`. */
    recordFailure(row: LogoSyncFailure): Promise<void>;
}

export interface LogoSyncCronDeps {
    base: CronDeps;
    repo: LogoSyncRepo;
    store: LogoStore;
    normalizer: LogoNormalizer;
    /** Test seams; production uses global fetch + dns.lookup. */
    fetchImpl?: typeof fetch;
    resolveHost?: ResolveHost;
    pinataGatewayHost?: string;
    pinataGatewayToken?: string;
    jupiterTokenApiUrl?: string;
}

function asObject(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object') throw new InvalidArgsError('args must be an object');
    return raw as Record<string, unknown>;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return Math.min(max, Math.max(min, fallback));
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError('numeric arg must be a finite number');
    }
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new InvalidArgsError('boolean arg must be true or false');
    return value;
}

const EXPLICIT_MINTS_MAX = 250;

function asMintList(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new InvalidArgsError('mints must be an array of strings');
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') throw new InvalidArgsError('mints must be an array of strings');
        const trimmed = item.trim();
        if (trimmed) out.push(trimmed);
    }
    if (out.length > EXPLICIT_MINTS_MAX) throw new InvalidArgsError(`mints must have at most ${EXPLICIT_MINTS_MAX} entries`);
    return Array.from(new Set(out));
}

export interface LogoSyncArgs {
    limit: number;
    concurrency: number;
    delayMs: number;
    budgetMs: number;
    resyncDays: number;
    /** Non-curated mints qualify when fetched within this many days. */
    tailDays: number;
    fetchTimeoutMs: number;
    /** Hard-capped at LOGO_MAX_BYTES. */
    maxBytes: number;
    mints?: string[];
    force: boolean;
}

export function parseLogoSyncArgs(rawArgs: unknown): LogoSyncArgs {
    const args = asObject(rawArgs);
    const mints = asMintList(args.mints);
    return {
        limit: clampInt(args.limit, 200, 1, 1000),
        concurrency: clampInt(args.concurrency, 3, 1, 6),
        delayMs: clampInt(args.delayMs, 250, 0, 10_000),
        budgetMs: clampInt(args.budgetMs, 480_000, 1_000, 530_000),
        resyncDays: clampInt(args.resyncDays, 7, 1, 365),
        tailDays: clampInt(args.tailDays, 30, 1, 3650),
        fetchTimeoutMs: clampInt(args.fetchTimeoutMs, 10_000, 1_000, 60_000),
        maxBytes: clampInt(args.maxBytes, LOGO_MAX_BYTES, 1024, LOGO_MAX_BYTES),
        ...(mints ? { mints } : {}),
        force: asBoolean(args.force, false),
    };
}

export function logoObjectKey(mint: string): string {
    return `${LOGO_OBJECT_PREFIX}/${mint}.webp`;
}

const DAY_MS = 86_400_000;

/**
 * Unchanged source + recent copy => nothing to do. IPFS references are
 * content-addressed, so an existing copy is never re-fetched on age alone.
 */
export function shouldSkipUnchanged(
    candidate: LogoSyncCandidate,
    sourceHash: string,
    nowMs: number,
    resyncDays: number,
): boolean {
    if (!candidate.logo_cdn_url || candidate.logo_source_hash !== sourceHash || candidate.logo_synced_at === null) {
        return false;
    }
    if (isIpfsSourceUrl(candidate.source_url)) return true;
    return nowMs - candidate.logo_synced_at < resyncDays * DAY_MS;
}

/** Effect wraps promise rejections (`UnknownError` with a `cause`); surface the innermost message. */
function describeError(error: unknown): string {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
        const cause = (current as { cause?: unknown }).cause;
        if (cause instanceof Error) {
            current = cause;
            continue;
        }
        if (cause !== undefined && cause !== null && !(cause instanceof Error)) return String(cause);
        break;
    }
    return current instanceof Error ? current.message : String(current);
}

type SourceCounters = Record<LogoSourceKind, { ok: number; fail: number }>;

function emptyCounters(): SourceCounters {
    return {
        pinata: { ok: 0, fail: 0 },
        origin: { ok: 0, fail: 0 },
        dexscreener: { ok: 0, fail: 0 },
        jupiter: { ok: 0, fail: 0 },
    };
}

interface AttemptOutcome {
    ok: boolean;
    /** Sniffed upstream type on success. */
    contentType?: string;
    webp?: Uint8Array;
    error?: string;
}

async function tryDirectAttempt(
    deps: LogoSyncCronDeps,
    args: LogoSyncArgs,
    attempt: Extract<FetchAttempt, { url: string }>,
): Promise<AttemptOutcome> {
    const fetched = await fetchLogoBytes(attempt.url, {
        provider: `logo_${attempt.source}`,
        headers: attempt.headers,
        timeoutMs: args.fetchTimeoutMs,
        maxBytes: args.maxBytes,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
    });
    if (!fetched.ok) {
        return { ok: false, error: fetched.status !== undefined ? `${fetched.reason}(${fetched.status})` : fetched.reason };
    }
    const sniffed = sniffImageContentType(fetched.bytes);
    if (!sniffed) return { ok: false, error: `unsupported_content_type(${fetched.contentType ?? 'unknown'})` };
    try {
        const normalized = await deps.normalizer.normalize(fetched.bytes, sniffed);
        return { ok: true, contentType: sniffed, webp: normalized.webp };
    } catch (err) {
        return { ok: false, error: `normalize_failed(${err instanceof Error ? err.message : String(err)})`.slice(0, 200) };
    }
}

async function tryJupiterLookup(
    deps: LogoSyncCronDeps,
    args: LogoSyncArgs,
    mint: string,
    lookupUrl: string,
    cfg: FetchPlanConfig,
    publicBaseUrl: string,
): Promise<AttemptOutcome> {
    const fetched = await fetchLogoBytes(lookupUrl, {
        provider: 'logo_jupiter_lookup',
        headers: { accept: 'application/json' },
        timeoutMs: args.fetchTimeoutMs,
        maxBytes: 512 * 1024,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}),
    });
    if (!fetched.ok) {
        return { ok: false, error: `lookup_${fetched.status !== undefined ? `${fetched.reason}(${fetched.status})` : fetched.reason}` };
    }
    let payload: unknown;
    try {
        payload = JSON.parse(new TextDecoder().decode(fetched.bytes));
    } catch {
        return { ok: false, error: 'lookup_invalid_json' };
    }
    const icon = extractJupiterIcon(payload, mint);
    if (!icon) return { ok: false, error: 'lookup_no_icon' };
    if (isFirstPartyLogoUrl(icon, publicBaseUrl)) return { ok: false, error: 'lookup_first_party_icon' };
    const errors: string[] = [];
    for (const direct of buildDirectAttempts(icon, cfg)) {
        if (direct.source === 'jupiter') continue;
        const outcome = await tryDirectAttempt(deps, args, direct);
        if (outcome.ok) return outcome;
        errors.push(`${direct.source}:${outcome.error ?? 'failed'}`);
    }
    return { ok: false, error: errors.length > 0 ? errors.join(',') : 'icon_on_public_gateway' };
}

export async function syncLogos(deps: LogoSyncCronDeps, rawArgs: unknown): Promise<CronResult> {
    const args = parseLogoSyncArgs(rawArgs);
    const start = deps.base.now();
    const publicBaseUrl = deps.store.publicUrl('').replace(/\/$/, '');
    const cfg: FetchPlanConfig = {
        pinataGatewayHost: deps.pinataGatewayHost,
        pinataGatewayToken: deps.pinataGatewayToken,
        jupiterTokenApiUrl: deps.jupiterTokenApiUrl,
    };

    const candidates = await deps.repo.listCandidates({
        curatedMints: deps.base.curated.getAllCuratedMintsInOrder(),
        ...(args.mints ? { mints: args.mints } : {}),
        limit: args.limit,
        nowMs: start,
        resyncBeforeMs: start - args.resyncDays * DAY_MS,
        tailSinceMs: start - args.tailDays * DAY_MS,
        force: args.force,
        publicBaseUrl,
    });

    if (candidates.length === 0) {
        return { ok: true, processed: 0, durationMs: deps.base.now() - start, skipped: true, reason: 'no_candidates' };
    }

    const bySource = emptyCounters();
    let synced = 0;
    let failed = 0;
    let skippedUnchanged = 0;
    let skippedFirstParty = 0;

    const summary = await Effect.runPromise(
        runJobPool({
            label: 'logo-sync',
            items: candidates,
            concurrency: args.concurrency,
            delayMs: args.delayMs,
            budgetMs: args.budgetMs,
            itemTimeoutMs: args.fetchTimeoutMs * 6 + 20_000,
            shouldStop: isShuttingDown,
            process: candidate =>
                Effect.tryPromise(async () => {
                    const nowMs = deps.base.now();
                    if (isFirstPartyLogoUrl(candidate.source_url, publicBaseUrl)) {
                        skippedFirstParty += 1;
                        return;
                    }
                    const sourceHash = await sha256Hex(candidate.source_url);
                    if (!args.force && shouldSkipUnchanged(candidate, sourceHash, nowMs, args.resyncDays)) {
                        skippedUnchanged += 1;
                        return;
                    }

                    const errors: string[] = [];
                    let success: { kind: LogoSourceKind; contentType: string; webp: Uint8Array } | null = null;
                    for (const attempt of buildFetchPlan(candidate.mint, candidate.source_url, cfg)) {
                        const outcome =
                            attempt.source === 'jupiter'
                                ? await tryJupiterLookup(deps, args, candidate.mint, attempt.lookupUrl, cfg, publicBaseUrl)
                                : await tryDirectAttempt(deps, args, attempt);
                        if (outcome.ok && outcome.webp && outcome.contentType) {
                            bySource[attempt.source].ok += 1;
                            success = { kind: attempt.source, contentType: outcome.contentType, webp: outcome.webp };
                            break;
                        }
                        bySource[attempt.source].fail += 1;
                        errors.push(`${attempt.source}:${outcome.error ?? 'failed'}`);
                    }

                    if (!success) {
                        const error = errors.join('; ').slice(0, 1000);
                        console.warn(`[logo-sync] mint=${candidate.mint} all sources failed: ${error}`);
                        await deps.repo.recordFailure({
                            mint: candidate.mint,
                            sourceUrl: candidate.source_url,
                            sourceTable: candidate.source_table,
                            error,
                            nowMs,
                        });
                        failed += 1;
                        return;
                    }

                    const key = logoObjectKey(candidate.mint);
                    await deps.store.put(key, success.webp, {
                        contentType: LOGO_OUTPUT_CONTENT_TYPE,
                        cacheControl: LOGO_CACHE_CONTROL,
                        metadata: {
                            'source-hash': sourceHash,
                            'source-kind': success.kind,
                            'source-url': candidate.source_url.slice(0, 1024),
                        },
                    });
                    await deps.repo.recordSuccess({
                        mint: candidate.mint,
                        sourceUrl: candidate.source_url,
                        sourceTable: candidate.source_table,
                        sourceKind: success.kind,
                        sourceHash,
                        cdnUrl: deps.store.publicUrl(key),
                        contentType: success.contentType,
                        nowMs,
                    });
                    synced += 1;
                }),
            onItemError: (candidate, error) =>
                Effect.tryPromise(async () => {
                    // Store/DB failure after the fetch plan: keep any previous copy, count the failure.
                    failed += 1;
                    const message = describeError(error);
                    console.error(`[logo-sync] mint=${candidate.mint} failed`, message);
                    await deps.repo.recordFailure({
                        mint: candidate.mint,
                        sourceUrl: candidate.source_url,
                        sourceTable: candidate.source_table,
                        error: `job:${message}`.slice(0, 1000),
                        nowMs: deps.base.now(),
                    });
                }),
        }),
    );

    console.log(
        JSON.stringify({
            event: 'logo_sync',
            candidates: candidates.length,
            synced,
            failed,
            skipped_unchanged: skippedUnchanged,
            skipped_first_party: skippedFirstParty,
            deadline_skipped: summary.deadlineSkipped,
            by_source: bySource,
            duration_ms: deps.base.now() - start,
        }),
    );

    const attempted = synced + failed;
    return {
        ok: !(attempted > 0 && synced === 0),
        processed: synced,
        durationMs: deps.base.now() - start,
        ...(summary.partial ? { partial: true } : {}),
        candidates: candidates.length,
        synced,
        failed,
        skippedUnchanged,
        skippedFirstParty,
        deadlineSkipped: summary.deadlineSkipped,
        bySource,
    };
}

export type LogoSyncJobHandler = (deps: LogoSyncCronDeps, args: unknown) => Promise<CronResult>;

export const logoSyncJobs: Record<string, LogoSyncJobHandler> = {
    'logo-sync': syncLogos,
};
