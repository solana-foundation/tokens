/**
 * Pure helpers for the admin Launches page. React-free so the page and
 * `bun test` share them (same rationale as advisory-labels.ts).
 */

import type { LaunchpadApproval, LaunchpadCandidateRow, LaunchpadPairAsset, LaunchpadQuoteAsset } from './admin-types';

/** Mirrors LAUNCH_NOTE_MAX_LENGTH in cloudrun-admin handlers/launchpadApprovals.ts. */
export const LAUNCH_NOTE_MAX_LENGTH = 500;

export const STONKFUN_TOKEN_URL_BASE = 'https://www.stonkfun.xyz/token/';

export function stonkfunTokenUrl(mint: string): string {
    return `${STONKFUN_TOKEN_URL_BASE}${encodeURIComponent(mint)}`;
}

export type LaunchNoteValidation = { ok: true; note: string | null } | { ok: false; error: string };

export function validateLaunchNote(input: string): LaunchNoteValidation {
    const note = input.trim();
    if (!note) return { ok: true, note: null };
    if (note.length > LAUNCH_NOTE_MAX_LENGTH) {
        return { ok: false, error: `Note must be at most ${LAUNCH_NOTE_MAX_LENGTH} characters.` };
    }
    return { ok: true, note };
}

/** Loose base58 shape check, matching cloudrun-admin's looksLikeSolanaMintAddress. */
export function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export type LaunchStatus = 'live' | 'pending identity' | 'not in last sync' | 'not synced yet';

/**
 * What the public surface would do with this row if it were approved:
 * - live: synced + active → shows on the quote asset's page
 * - pending identity: synced this run but Birdeye identity not written yet
 * - not in last sync: was synced before, missing from the latest provider run
 * - not synced yet: approved by address, no synced row at all
 */
export function launchStatusLabel(
    row: Pick<LaunchpadCandidateRow, 'synced' | 'isActive' | 'lastSyncedAt'>,
    latestSyncMs: number | null,
): LaunchStatus {
    if (!row.synced) return 'not synced yet';
    if (row.isActive) return 'live';
    if (latestSyncMs !== null && row.lastSyncedAt !== null && row.lastSyncedAt < latestSyncMs) {
        return 'not in last sync';
    }
    return 'pending identity';
}

export function launchStatusTone(status: LaunchStatus): 'ok' | 'warn' | 'muted' {
    if (status === 'live') return 'ok';
    if (status === 'pending identity') return 'warn';
    return 'muted';
}

/** Newest `lastSyncedAt` across rows; the sync stamps every selected row with the same value. */
export function latestSyncTimestamp(rows: readonly Pick<LaunchpadCandidateRow, 'lastSyncedAt'>[]): number | null {
    let latest: number | null = null;
    for (const row of rows) {
        if (row.lastSyncedAt === null) continue;
        latest = latest === null ? row.lastSyncedAt : Math.max(latest, row.lastSyncedAt);
    }
    return latest;
}

export function launchApproverLabel(approval: Pick<LaunchpadApproval, 'approvedBy' | 'approvedByEmail'>): string {
    if (approval.approvedByEmail) return approval.approvedByEmail;
    const id = approval.approvedBy;
    return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

export function formatUsdCompact(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(0)}`;
}

export function formatCompactMint(mint: string): string {
    return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

/** Key for approvals by address that the sync has not stored yet (no quote mint known). */
export const UNSYNCED_GROUP_KEY = 'unsynced';

export interface LaunchGroup {
    key: string;
    /** Canonical quote asset; null for the unsynced group or a quote mint no asset owns. */
    asset: LaunchpadQuoteAsset | null;
    quoteMints: string[];
    quoteSymbol: string | null;
    rows: LaunchpadCandidateRow[];
    counts: { candidates: number; approved: number; live: number };
    volume24hUsd: number;
    lastSyncedAt: number | null;
}

export function isRowLive(row: Pick<LaunchpadCandidateRow, 'synced' | 'isActive' | 'approval'>): boolean {
    return row.synced && row.isActive && row.approval !== null;
}

/**
 * Groups candidate rows by the quote asset they would show on (Curation-style
 * parent rows). Order: the unsynced group first when non-empty, then groups
 * with approvals, then by summed 24h volume. Rows inside a group: approved
 * first, then by 24h volume.
 */
export function groupLaunchCandidates(rows: readonly LaunchpadCandidateRow[]): LaunchGroup[] {
    const groups = new Map<string, LaunchGroup>();
    for (const row of rows) {
        const key = !row.synced ? UNSYNCED_GROUP_KEY : (row.quoteAsset?.assetId ?? row.quoteMint ?? UNSYNCED_GROUP_KEY);
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                asset: key === UNSYNCED_GROUP_KEY ? null : row.quoteAsset,
                quoteMints: [],
                quoteSymbol: key === UNSYNCED_GROUP_KEY ? null : row.quoteSymbol,
                rows: [],
                counts: { candidates: 0, approved: 0, live: 0 },
                volume24hUsd: 0,
                lastSyncedAt: null,
            };
            groups.set(key, group);
        }
        if (row.quoteMint && !group.quoteMints.includes(row.quoteMint)) group.quoteMints.push(row.quoteMint);
        if (!group.quoteSymbol && row.quoteSymbol && key !== UNSYNCED_GROUP_KEY) group.quoteSymbol = row.quoteSymbol;
        group.rows.push(row);
        group.counts.candidates += 1;
        if (row.approval) group.counts.approved += 1;
        if (isRowLive(row)) group.counts.live += 1;
        group.volume24hUsd += row.volume24hUsd ?? 0;
        if (row.lastSyncedAt !== null) {
            group.lastSyncedAt =
                group.lastSyncedAt === null ? row.lastSyncedAt : Math.max(group.lastSyncedAt, row.lastSyncedAt);
        }
    }

    const out = [...groups.values()];
    for (const group of out) {
        group.rows.sort(
            (a, b) =>
                Number(b.approval !== null) - Number(a.approval !== null) ||
                (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) ||
                a.mint.localeCompare(b.mint),
        );
    }
    out.sort(
        (a, b) =>
            Number(b.key === UNSYNCED_GROUP_KEY) - Number(a.key === UNSYNCED_GROUP_KEY) ||
            Number(b.counts.approved > 0) - Number(a.counts.approved > 0) ||
            b.volume24hUsd - a.volume24hUsd ||
            a.key.localeCompare(b.key),
    );
    return out;
}

export function launchGroupLabel(group: Pick<LaunchGroup, 'key' | 'asset' | 'quoteSymbol'>): {
    symbol: string;
    name: string;
} {
    if (group.key === UNSYNCED_GROUP_KEY)
        return { symbol: 'Not synced yet', name: 'Approved by address; stored on the next sync' };
    if (group.asset) {
        return {
            symbol: group.asset.symbol ?? group.quoteSymbol ?? group.asset.assetId,
            name: group.asset.name ?? group.asset.assetId,
        };
    }
    return { symbol: group.quoteSymbol ?? 'Unknown quote', name: 'Quote mint is not a curated asset' };
}

/** Case-insensitive match over asset + coin identity fields, for the Launches search box. */
export function launchGroupMatches(group: LaunchGroup, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const label = launchGroupLabel(group);
    const hay = [label.symbol, label.name, group.asset?.assetId ?? '', ...group.quoteMints];
    for (const row of group.rows) hay.push(row.symbol ?? '', row.name ?? '', row.mint);
    return hay.some(value => value.toLowerCase().includes(q));
}

/**
 * Seeds one row per curated asset stonk.fun accepts as a quote token, so an
 * asset like NVIDIA appears even before any coin exists for it. Groups that
 * already have rows keep them; pairs contribute quote mints and identity.
 */
export function mergePairAssets(groups: readonly LaunchGroup[], pairs: readonly LaunchpadPairAsset[]): LaunchGroup[] {
    const byKey = new Map<string, LaunchGroup>();
    for (const group of groups) byKey.set(group.key, { ...group, quoteMints: [...group.quoteMints] });
    for (const pair of pairs) {
        const existing = byKey.get(pair.assetId);
        if (existing) {
            for (const q of pair.quoteMints)
                if (!existing.quoteMints.includes(q.mint)) existing.quoteMints.push(q.mint);
            if (!existing.asset) {
                existing.asset = {
                    assetId: pair.assetId,
                    name: pair.name,
                    symbol: pair.symbol,
                    imageUrl: pair.imageUrl,
                };
            }
            if (!existing.quoteSymbol) existing.quoteSymbol = pair.quoteMints[0]?.symbol ?? null;
            continue;
        }
        byKey.set(pair.assetId, {
            key: pair.assetId,
            asset: { assetId: pair.assetId, name: pair.name, symbol: pair.symbol, imageUrl: pair.imageUrl },
            quoteMints: pair.quoteMints.map(q => q.mint),
            quoteSymbol: pair.quoteMints[0]?.symbol ?? null,
            rows: [],
            counts: { candidates: 0, approved: 0, live: 0 },
            volume24hUsd: 0,
            lastSyncedAt: null,
        });
    }
    const out = [...byKey.values()];
    out.sort(
        (a, b) =>
            Number(b.key === UNSYNCED_GROUP_KEY) - Number(a.key === UNSYNCED_GROUP_KEY) ||
            Number(b.counts.approved > 0) - Number(a.counts.approved > 0) ||
            Number(b.counts.candidates > 0) - Number(a.counts.candidates > 0) ||
            b.volume24hUsd - a.volume24hUsd ||
            launchGroupLabel(a).symbol.localeCompare(launchGroupLabel(b).symbol, undefined, { sensitivity: 'base' }),
    );
    return out;
}
