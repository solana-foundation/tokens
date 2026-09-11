import { isAdvisoryStatus, type AdvisoryStatus } from '@tokens/asset-registry';

/** Raw row from asset_variant_advisories; bigint columns may arrive as string or bigint. */
export interface AssetAdvisoryRow {
    mint: string;
    status: string;
    reason: string;
    url: string | null;
    set_at: number | string | bigint;
    updated_at: number | string | bigint;
}

export interface AssetAdvisoriesRepo {
    listAll(): Promise<AssetAdvisoryRow[]>;
}

export interface AssetAdvisoryListEntry {
    mint: string;
    status: AdvisoryStatus;
    reason: string;
    url: string | null;
    /** Unix ms; the advisory's set_at (reset when status changes). */
    since: number;
}

export interface AssetAdvisoriesListResult {
    /** max(updated_at) over live rows; 0 when there are none. Callers use it as a cache key. */
    revision: number;
    advisories: AssetAdvisoryListEntry[];
}

function toEpochMs(value: number | string | bigint): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Full snapshot of live advisories. Takes no RPC args: the table is tiny and
 * the API caches the whole set keyed by `revision`.
 */
export async function listAdvisories(repo: AssetAdvisoriesRepo): Promise<AssetAdvisoriesListResult> {
    const rows = await repo.listAll();
    let revision = 0;
    const advisories: AssetAdvisoryListEntry[] = [];
    for (const row of rows) {
        // The CHECK constraint makes this unreachable today; guard anyway so a
        // future status added to the DB before the package never breaks reads.
        if (!isAdvisoryStatus(row.status)) continue;
        const updatedAt = toEpochMs(row.updated_at);
        if (updatedAt > revision) revision = updatedAt;
        advisories.push({
            mint: row.mint,
            status: row.status,
            reason: row.reason,
            url: row.url ?? null,
            since: toEpochMs(row.set_at),
        });
    }
    return { revision, advisories };
}
