import { InvalidArgsError } from './assets';
import { resolveLogoUri } from './logoUrl';

// Read side of `launchpad_tokens_latest` (see crons.launchpad.ts for the sync).
// Served over the cloudrun RPC as `launchpadListByQuoteMints`; the API joins
// the result onto an asset's variant mints to render "Launched on <SYMBOL>".
// Approved-only: the repo joins `launchpad_mint_approvals` (migration 0022),
// so a coin without an admin approval never reaches the API or the web.

export interface LaunchpadTokenRow {
    launchpad: string;
    mint: string;
    quote_mint: string;
    quote_symbol: string | null;
    symbol: string | null;
    name: string | null;
    logo_uri: string | null;
    logo_cdn_url?: string | null;
    pool: string | null;
    status: string | null;
    mode: string | null;
    price_usd: number | null;
    market_cap_usd: number | null;
    fdv_usd: number | null;
    liquidity_usd: number | null;
    volume_24h_usd: number | null;
    price_change_24h: number | null;
    launched_at: number | string | bigint | null;
    graduated_at: number | string | bigint | null;
    source_rank: number;
    last_synced_at: number | string | bigint;
}

export interface LaunchpadReadsRepo {
    listActiveByQuoteMints(quoteMints: readonly string[], limit: number): Promise<LaunchpadTokenRow[]>;
}

export interface LaunchpadTokenResult {
    launchpad: string;
    mint: string;
    quoteMint: string;
    quoteSymbol: string | null;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    pool: string | null;
    status: string | null;
    mode: string | null;
    price: number | null;
    marketCap: number | null;
    fdv: number | null;
    liquidity: number | null;
    volume24hUSD: number | null;
    priceChange24hPercent: number | null;
    launchedAt: number | null;
    graduatedAt: number | null;
    sourceRank: number;
    lastSyncedAt: number;
}

const MAX_QUOTE_MINTS = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toEpochMs(value: number | string | bigint | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteOrNull(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function rowToLaunchpadResult(row: LaunchpadTokenRow): LaunchpadTokenResult {
    return {
        launchpad: row.launchpad,
        mint: row.mint,
        quoteMint: row.quote_mint,
        quoteSymbol: row.quote_symbol ?? null,
        symbol: row.symbol ?? null,
        name: row.name ?? null,
        logoURI: resolveLogoUri(row),
        pool: row.pool ?? null,
        status: row.status ?? null,
        mode: row.mode ?? null,
        price: toFiniteOrNull(row.price_usd),
        marketCap: toFiniteOrNull(row.market_cap_usd),
        fdv: toFiniteOrNull(row.fdv_usd),
        liquidity: toFiniteOrNull(row.liquidity_usd),
        volume24hUSD: toFiniteOrNull(row.volume_24h_usd),
        priceChange24hPercent: toFiniteOrNull(row.price_change_24h),
        launchedAt: toEpochMs(row.launched_at),
        graduatedAt: toEpochMs(row.graduated_at),
        sourceRank: row.source_rank,
        lastSyncedAt: toEpochMs(row.last_synced_at) ?? 0,
    };
}

function readQuoteMints(args: Record<string, unknown>): string[] {
    const raw = args.quoteMints;
    if (!Array.isArray(raw)) throw new InvalidArgsError('quoteMints must be an array of strings');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of raw) {
        if (typeof value !== 'string') throw new InvalidArgsError('quoteMints must be an array of strings');
        const mint = value.trim();
        if (!mint || seen.has(mint)) continue;
        seen.add(mint);
        out.push(mint);
        if (out.length >= MAX_QUOTE_MINTS) break;
    }
    return out;
}

function readLimit(args: Record<string, unknown>): number {
    const value = args.limit;
    if (value === undefined) return DEFAULT_LIMIT;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidArgsError('limit must be a finite number');
    }
    return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT);
}

export async function listByQuoteMints(repo: LaunchpadReadsRepo, args: unknown): Promise<LaunchpadTokenResult[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as Record<string, unknown>;
    const quoteMints = readQuoteMints(a);
    const limit = readLimit(a);
    if (quoteMints.length === 0) return [];
    const rows = await repo.listActiveByQuoteMints(quoteMints, limit);
    return rows.map(rowToLaunchpadResult);
}
