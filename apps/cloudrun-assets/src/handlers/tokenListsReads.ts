import { InvalidArgsError } from './assets';

/**
 * Reads for community token lists ("lists as plugins"): project-owned,
 * mint-keyed lists managed entirely through the API. Distinct from
 * asset_collections, which are registry-seeded and asset_id-keyed.
 */

export interface TokenListSummaryRow {
    slug: string;
    name: string;
    owner_project_id: string;
    member_count: number;
    /** Unix ms. */
    updated_at: number;
}

export interface TokenListRow {
    id: string;
    slug: string;
    owner_project_id: string;
    name: string;
    status: string;
    member_count: number;
    /** Unix ms. */
    created_at: number;
    /** Unix ms. */
    updated_at: number;
}

export interface TokenListMemberRow {
    mint: string;
    rank: number;
    note: string | null;
    /** Unix ms. */
    added_at: number;
    symbol: string | null;
    name: string | null;
    logo_uri: string | null;
    decimals: number | null;
    /** An active, non-tombstoned registry variant exists for this mint. */
    verified: boolean;
}

export interface TokenListMintSlugRow {
    mint: string;
    slug: string;
}

export interface TokenListsReadsRepo {
    listPublished(limit: number, offset: number): Promise<TokenListSummaryRow[]>;
    /** Any status — callers decide visibility (public reads show published only). */
    getBySlug(slug: string): Promise<TokenListRow | null>;
    listMembersBySlug(slug: string, limit: number, offset: number): Promise<TokenListMemberRow[]>;
    /** (mint, slug) pairs for published lists containing any of the mints. */
    listSlugsByMints(mints: readonly string[]): Promise<TokenListMintSlugRow[]>;
}

export interface TokenListSummary {
    slug: string;
    name: string;
    ownerProjectId: string;
    tokenCount: number;
    updatedAt: number;
}

export interface TokenListDetail extends TokenListSummary {
    status: string;
    createdAt: number;
}

export interface TokenListMember {
    mint: string;
    rank: number;
    note: string | null;
    addedAt: number;
    symbol: string | null;
    name: string | null;
    logoUri: string | null;
    decimals: number | null;
    verified: boolean;
}

function decodePagination(
    a: { limit?: unknown; offset?: unknown },
    defaults: { limit: number; maxLimit: number },
): { limit: number; offset: number } {
    if (a.limit !== undefined && typeof a.limit !== 'number') {
        throw new InvalidArgsError('limit must be a number when present');
    }
    if (a.offset !== undefined && typeof a.offset !== 'number') {
        throw new InvalidArgsError('offset must be a number when present');
    }
    const limit = Math.min(
        Math.max(typeof a.limit === 'number' ? Math.floor(a.limit) : defaults.limit, 1),
        defaults.maxLimit,
    );
    const offset = Math.max(typeof a.offset === 'number' ? Math.floor(a.offset) : 0, 0);
    return { limit, offset };
}

function summaryFromRow(row: TokenListSummaryRow): TokenListSummary {
    return {
        slug: row.slug,
        name: row.name,
        ownerProjectId: row.owner_project_id,
        tokenCount: row.member_count,
        updatedAt: Number(row.updated_at),
    };
}

export async function listPublished(
    repo: TokenListsReadsRepo,
    args: unknown,
): Promise<TokenListSummary[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { limit?: unknown; offset?: unknown };
    const { limit, offset } = decodePagination(a, { limit: 100, maxLimit: 500 });
    const rows = await repo.listPublished(limit, offset);
    return rows.map(summaryFromRow);
}

export async function getBySlug(
    repo: TokenListsReadsRepo,
    args: unknown,
): Promise<TokenListDetail | null> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { slug?: unknown };
    if (typeof a.slug !== 'string') {
        throw new InvalidArgsError('slug must be a string');
    }
    const slug = a.slug.trim();
    if (!slug) return null;
    const row = await repo.getBySlug(slug);
    if (!row) return null;
    return {
        ...summaryFromRow(row),
        status: row.status,
        createdAt: Number(row.created_at),
    };
}

/** mint → slugs of published community lists containing it. */
export async function getSlugsByMints(
    repo: TokenListsReadsRepo,
    args: unknown,
): Promise<Array<{ mint: string; slugs: string[] }>> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mints?: unknown };
    if (!Array.isArray(a.mints) || a.mints.some(m => typeof m !== 'string')) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    const mints = [...new Set((a.mints as string[]).map(m => m.trim()).filter(Boolean))].slice(0, 500);
    if (mints.length === 0) return [];
    const rows = await repo.listSlugsByMints(mints);
    const byMint = new Map<string, string[]>();
    for (const row of rows) {
        const existing = byMint.get(row.mint);
        if (existing) existing.push(row.slug);
        else byMint.set(row.mint, [row.slug]);
    }
    return Array.from(byMint.entries(), ([mint, slugs]) => ({ mint, slugs }));
}

export async function getMembers(
    repo: TokenListsReadsRepo,
    args: unknown,
): Promise<TokenListMember[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { slug?: unknown; limit?: unknown; offset?: unknown };
    if (typeof a.slug !== 'string') {
        throw new InvalidArgsError('slug must be a string');
    }
    const slug = a.slug.trim();
    if (!slug) return [];
    const { limit, offset } = decodePagination(a, { limit: 500, maxLimit: 2000 });
    const rows = await repo.listMembersBySlug(slug, limit, offset);
    return rows.map(row => ({
        mint: row.mint,
        rank: row.rank,
        note: row.note,
        addedAt: Number(row.added_at),
        symbol: row.symbol,
        name: row.name,
        logoUri: row.logo_uri,
        decimals: row.decimals,
        verified: row.verified === true,
    }));
}
