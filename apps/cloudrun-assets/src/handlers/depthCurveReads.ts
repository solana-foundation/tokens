import { InvalidArgsError } from './assets';
import { DEPTH_QUOTE_SOURCES, DEPTH_USDC_QUOTE_MINT, type DepthQuoteSourceId } from './crons.depth';

export interface DepthCurveRow {
    mint: string;
    quote_mint: string;
    side: string;
    source: string;
    ladder: unknown;
    points: number;
    failed_points: number;
    as_of: number;
    last_computed_at: number;
}

export interface DepthCurveReadsRepo {
    findLatestByMints(args: {
        mints: readonly string[];
        quoteMint: string;
        side: 'buy' | 'sell';
        source: DepthQuoteSourceId;
    }): Promise<DepthCurveRow[]>;
}

export interface DepthCurveLadderPoint {
    sizeUsd: number;
    inAmount: number;
    outAmount: number;
    priceImpactBps: number | null;
    effectivePrice: number;
    routeVenues: string[];
    contextSlot?: number;
}

export interface DepthCurveDoc {
    mint: string;
    quoteMint: string;
    side: 'buy' | 'sell';
    source: DepthQuoteSourceId;
    ladder: DepthCurveLadderPoint[];
    points: number;
    failedPoints: number;
    asOf: number;
    lastComputedAt: number;
}

export interface GetLatestByMintsEntry {
    mint: string;
    depthCurve: DepthCurveDoc | null;
}

function toFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeLadderPoint(raw: unknown): DepthCurveLadderPoint | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sizeUsd = toFiniteNumber(record.sizeUsd);
    const inAmount = toFiniteNumber(record.inAmount);
    const outAmount = toFiniteNumber(record.outAmount);
    const effectivePrice = toFiniteNumber(record.effectivePrice);
    if (sizeUsd === null || inAmount === null || outAmount === null || effectivePrice === null) return null;
    const contextSlot = toFiniteNumber(record.contextSlot);
    return {
        sizeUsd,
        inAmount,
        outAmount,
        priceImpactBps: toFiniteNumber(record.priceImpactBps),
        effectivePrice,
        routeVenues: Array.isArray(record.routeVenues)
            ? record.routeVenues.filter((venue): venue is string => typeof venue === 'string')
            : [],
        ...(contextSlot !== null ? { contextSlot } : {}),
    };
}

function rowToDoc(row: DepthCurveRow): DepthCurveDoc | null {
    if (row.side !== 'buy' && row.side !== 'sell') return null;
    if (!DEPTH_QUOTE_SOURCES.includes(row.source as DepthQuoteSourceId)) return null;
    const ladder = Array.isArray(row.ladder)
        ? row.ladder.map(normalizeLadderPoint).filter((point): point is DepthCurveLadderPoint => point !== null)
        : [];
    return {
        mint: row.mint,
        quoteMint: row.quote_mint,
        side: row.side,
        source: row.source as DepthQuoteSourceId,
        ladder,
        points: row.points,
        failedPoints: row.failed_points,
        asOf: row.as_of,
        lastComputedAt: row.last_computed_at,
    };
}

export async function getLatestByMints(repo: DepthCurveReadsRepo, args: unknown): Promise<GetLatestByMintsEntry[]> {
    if (typeof args !== 'object' || args === null) {
        throw new InvalidArgsError('args must be an object');
    }
    const a = args as { mints?: unknown; side?: unknown; quoteMint?: unknown; source?: unknown };
    if (!Array.isArray(a.mints)) {
        throw new InvalidArgsError('mints must be an array of strings');
    }
    for (const item of a.mints) {
        if (typeof item !== 'string') {
            throw new InvalidArgsError('mints must be an array of strings');
        }
    }
    const side = a.side === undefined ? 'buy' : a.side;
    if (side !== 'buy' && side !== 'sell') {
        throw new InvalidArgsError('side must be buy or sell');
    }
    const source = a.source === undefined ? 'titan' : a.source;
    if (typeof source !== 'string' || !DEPTH_QUOTE_SOURCES.includes(source as DepthQuoteSourceId)) {
        throw new InvalidArgsError(`source must be one of ${DEPTH_QUOTE_SOURCES.join(', ')}`);
    }
    const quoteMint = a.quoteMint === undefined ? DEPTH_USDC_QUOTE_MINT : a.quoteMint;
    if (typeof quoteMint !== 'string' || !quoteMint.trim()) {
        throw new InvalidArgsError('quoteMint must be a non-empty string');
    }

    const mints = (a.mints as string[]).slice(0, 250).map(m => m.trim()).filter(Boolean);
    if (mints.length === 0) return [];

    const rows = await repo.findLatestByMints({
        mints,
        quoteMint: quoteMint.trim(),
        side,
        source: source as DepthQuoteSourceId,
    });
    const byMint = new Map(rows.map(r => [r.mint, r] as const));
    return mints.map(mint => {
        const row = byMint.get(mint);
        if (!row) return { mint, depthCurve: null };
        return { mint, depthCurve: rowToDoc(row) };
    });
}
