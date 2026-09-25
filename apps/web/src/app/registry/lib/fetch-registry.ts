import 'server-only';

import { cacheLife } from 'next/cache';

import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';
import { fetchBirdeyeTokenMetadata, normalizeLogoURI, type BirdeyeTokenMetadata } from './birdeye-metadata';
import type {
    AssetRegistryApiResponse,
    AssetRegistryApiRow,
    CuratedMintEntry,
    MarketSnapshotEntry,
    RegistryData,
    RegistryRow,
} from './types';

const DEFAULT_REGISTRY_URL = 'https://data.solana.com/v1/assets';
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

    const apiKey = process.env.SOLANA_DATA_API_KEY?.trim();
    if (!apiKey) {
        throw new Error('SOLANA_DATA_API_KEY is not configured');
    }
    const url = process.env.ASSET_REGISTRY_API_URL?.trim() || DEFAULT_REGISTRY_URL;

    const response = await fetch(url, {
        headers: { accept: 'application/json', 'x-api-key': apiKey },
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

    // Mints the platform does not index yet: fill logo + name straight from Birdeye.
    const unindexed = rows
        .map(row => row.mint_address)
        .filter(mint => looksLikeSolanaMintAddress(mint) && !hasLogo(snapshots.get(mint), curated.get(mint)));
    const birdeye = await fetchBirdeyeTokenMetadata(unindexed);

    const normalized = rows.map(row =>
        normalizeRow(
            row,
            snapshots.get(row.mint_address),
            curated.get(row.mint_address),
            birdeye.get(row.mint_address),
        ),
    );

    console.info(
        JSON.stringify({
            event: 'asset_registry_loaded',
            rows: normalized.length,
            withLogo: normalized.filter(row => row.logoURI).length,
            withName: normalized.filter(row => row.name).length,
            birdeyeLookups: unindexed.length,
            birdeyeHits: birdeye.size,
        }),
    );

    return {
        generatedAt: payload.data.generatedAt,
        truncated: payload.data.truncated === true,
        rows: sortByValueDesc(normalized),
    };
}

/**
 * Canonical ordering agreed with the data team: coalesced value descending,
 * rows without any value last. `Array.prototype.sort` is stable, so ties keep
 * the upstream order.
 */
function sortByValueDesc(rows: RegistryRow[]): RegistryRow[] {
    return [...rows].sort((a, b) => {
        if (a.valueUsd == null) return b.valueUsd == null ? 0 : 1;
        if (b.valueUsd == null) return -1;
        return b.valueUsd - a.valueUsd;
    });
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

function hasLogo(snapshot: MarketSnapshotEntry | undefined, curated: CuratedMintEntry | undefined): boolean {
    return Boolean(snapshot?.token?.logoURI || curated?.primaryVariant?.market?.logoURI);
}

function normalizeRow(
    row: AssetRegistryApiRow,
    snapshot: MarketSnapshotEntry | undefined,
    curated: CuratedMintEntry | undefined,
    provider: BirdeyeTokenMetadata | undefined,
): RegistryRow {
    const token = snapshot?.token ?? null;
    const variant = curated?.primaryVariant ?? null;
    const rwaValueUsd = parseUsd(row.rwa_asset_value_usd);
    const alliumValueUsd = parseUsd(row.allium_asset_value_usd);
    const marketCapUsd = parseUsd(row.coingecko_market_cap);
    return {
        symbol: row.token,
        mintAddress: row.mint_address,
        name: token?.name?.trim() || variant?.name?.trim() || provider?.name || null,
        logoURI: normalizeLogoURI(token?.logoURI || variant?.market?.logoURI || null) || provider?.logoURI || null,
        hasTokenPage: token != null || variant != null,
        solanaClass: row.solana_asset_class,
        rwaClass: row.rwa_asset_class,
        alliumClass: row.allium_asset_class,
        rwaValueUsd,
        alliumValueUsd,
        marketCapUsd,
        valueUsd: alliumValueUsd ?? rwaValueUsd ?? marketCapUsd,
    };
}

function parseUsd(value: string | null): number | null {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
