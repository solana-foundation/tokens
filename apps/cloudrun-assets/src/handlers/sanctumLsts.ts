import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

export interface SanctumLstRow {
    mint: string;
    symbol: string | null;
    symbol_lower: string;
    name: string | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    website_url: string | null;
    tvl_usd: number | null;
    apy: number | null;
    source_rank: number;
    is_active: boolean;
    last_seen_at: number;
    last_synced_at: number;
    created_at: number;
    updated_at: number;
}

export interface SanctumLstsRepo {
    listActive(limit: number): Promise<SanctumLstRow[]>;
    findByMint(mint: string): Promise<SanctumLstRow | null>;
    findActiveBySymbolLower(symbolLower: string, limit: number): Promise<SanctumLstRow[]>;
}

export interface SanctumLstResult {
    mint: string;
    symbol?: string;
    symbolLower: string;
    name?: string;
    logoURI?: string;
    websiteUrl?: string;
    tvlUsd?: number;
    apy?: number;
    sourceRank: number;
    isActive: boolean;
    lastSeenAt: number;
    lastSyncedAt: number;
    createdAt: number;
    updatedAt: number;
}

export interface SanctumResolveRefResult {
    mint: string;
    symbol?: string;
    sourceRank: number;
}

function rowToResult(row: SanctumLstRow): SanctumLstResult {
    const out: SanctumLstResult = {
        mint: row.mint,
        symbolLower: row.symbol_lower,
        sourceRank: row.source_rank,
        isActive: row.is_active,
        lastSeenAt: row.last_seen_at,
        lastSyncedAt: row.last_synced_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (row.symbol !== null) out.symbol = row.symbol;
    if (row.name !== null) out.name = row.name;
    const logoURI = resolveLogoUri(row);
    if (logoURI !== null) out.logoURI = logoURI;
    if (row.website_url !== null) out.websiteUrl = row.website_url;
    if (row.tvl_usd !== null) out.tvlUsd = row.tvl_usd;
    if (row.apy !== null) out.apy = row.apy;
    return out;
}

function normalizeQuery(value: string): string {
    return value.trim().toLowerCase();
}

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError(`${key} must be a finite number`);
    }
    return value;
}

export async function listActive(
    repo: SanctumLstsRepo,
    args: unknown,
): Promise<SanctumLstResult[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const limitArg = readOptionalNumber(args as Record<string, unknown>, 'limit');
    const limit = Math.min(Math.max(limitArg ?? 500, 1), 5000);
    const rows = await repo.listActive(limit);
    return rows.map(rowToResult);
}

export async function resolveRef(
    repo: SanctumLstsRepo,
    args: unknown,
): Promise<SanctumResolveRefResult | null> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { ref?: unknown };
    if (typeof a.ref !== 'string') {
        throw new InvalidArgsError('ref must be a string');
    }
    const ref = a.ref.trim();
    if (!ref) return null;

    if (looksLikeSolanaMintAddress(ref)) {
        const doc = await repo.findByMint(ref);
        if (doc && doc.is_active) {
            const out: SanctumResolveRefResult = { mint: doc.mint, sourceRank: doc.source_rank };
            if (doc.symbol !== null) out.symbol = doc.symbol;
            return out;
        }
    }

    const symbolLower = normalizeQuery(ref);
    if (!symbolLower) return null;

    const matches = await repo.findActiveBySymbolLower(symbolLower, 25);
    if (matches.length === 0) return null;

    matches.sort((a, b) => (a.source_rank ?? 0) - (b.source_rank ?? 0));
    const best = matches[0]!;
    const out: SanctumResolveRefResult = { mint: best.mint, sourceRank: best.source_rank };
    if (best.symbol !== null) out.symbol = best.symbol;
    return out;
}
