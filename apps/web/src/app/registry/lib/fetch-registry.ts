import 'server-only';

import { cacheLife } from 'next/cache';

import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';
import type {
    AssetRegistryApiResponse,
    AssetRegistryApiRow,
    CuratedMintEntry,
    MarketSnapshotEntry,
    RegistryData,
    RegistryRow,
} from './types';

const FETCH_TIMEOUT_MS = 15_000;
// Server-side cap on /api/v1/assets/market-snapshots.
const SNAPSHOT_BATCH_SIZE = 250;
const SNAPSHOT_CONCURRENCY = 4;

/**
 * Throws on any failure so the error is never cached: the page falls back to
 * an "unavailable" panel and the next request retries the upstream.
 */
export async function fetchRegistry(): Promise<RegistryData> {
    'use cache';
    cacheLife('hours');

    const url = process.env.ASSET_REGISTRY_API_URL;
    if (!url) {
        throw new Error('ASSET_REGISTRY_API_URL is not configured');
    }

    const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`Asset registry request failed: ${response.status}`);
    }

    const payload = (await response.json()) as AssetRegistryApiResponse;
    const rows = payload?.data?.rows;
    if (!Array.isArray(rows)) {
        throw new Error('Asset registry response is missing data.rows');
    }

    const [snapshots, curated] = await Promise.all([
        fetchMarketSnapshots(rows.map(row => row.mint_address)),
        fetchCuratedMints(),
    ]);

    return {
        generatedAt: payload.data.generatedAt,
        truncated: payload.data.truncated === true,
        rows: rows.map(row => normalizeRow(row, snapshots.get(row.mint_address), curated.get(row.mint_address))),
    };
}

/**
 * Second enrichment source: the curated registry keyed by mint. Its
 * `primaryVariant.market.logoURI` is the indexed per-mint logo (the search
 * table behind market-snapshots only covers mints with live Birdeye markets).
 */
async function fetchCuratedMints(): Promise<Map<string, CuratedMintEntry>> {
    const response = await fetchApiAppJsonOrNull<{ assets?: CuratedMintEntry[] }>(
        '/api/v1/assets/curated?list=all&groupBy=mint&variants=all',
    );
    const byMint = new Map<string, CuratedMintEntry>();
    for (const entry of response?.assets ?? []) {
        const mint = entry?.primaryVariant?.mint;
        if (mint && !byMint.has(mint)) byMint.set(mint, entry);
    }
    return byMint;
}

/**
 * Best-effort enrichment from the Tokens platform API. A failed batch just
 * leaves its mints unenriched rather than failing the whole page.
 */
async function fetchMarketSnapshots(mints: string[]): Promise<Map<string, MarketSnapshotEntry>> {
    const unique = [...new Set(mints.filter(looksLikeSolanaMintAddress))];
    const batches: string[][] = [];
    for (let index = 0; index < unique.length; index += SNAPSHOT_BATCH_SIZE) {
        batches.push(unique.slice(index, index + SNAPSHOT_BATCH_SIZE));
    }

    const byMint = new Map<string, MarketSnapshotEntry>();
    let cursor = 0;
    const worker = async () => {
        while (cursor < batches.length) {
            const batch = batches[cursor++]!;
            const entries = await fetchApiAppJsonOrNull<MarketSnapshotEntry[]>('/api/v1/assets/market-snapshots', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ mints: batch }),
            });
            for (const entry of entries ?? []) {
                if (entry?.address) byMint.set(entry.address, entry);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, batches.length) }, worker));
    return byMint;
}

function normalizeRow(
    row: AssetRegistryApiRow,
    snapshot: MarketSnapshotEntry | undefined,
    curated: CuratedMintEntry | undefined,
): RegistryRow {
    const token = snapshot?.token ?? null;
    const variant = curated?.primaryVariant ?? null;
    return {
        symbol: row.token,
        mintAddress: row.mint_address,
        name: token?.name?.trim() || variant?.name?.trim() || null,
        logoURI: token?.logoURI || variant?.market?.logoURI || null,
        hasTokenPage: token != null || variant != null,
        solanaClass: row.solana_asset_class,
        rwaClass: row.rwa_asset_class,
        alliumClass: row.allium_asset_class,
        rwaValueUsd: parseUsd(row.rwa_asset_value_usd),
        alliumValueUsd: parseUsd(row.allium_asset_value_usd),
        marketCapUsd: parseUsd(row.coingecko_market_cap),
    };
}

function parseUsd(value: string | null): number | null {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
