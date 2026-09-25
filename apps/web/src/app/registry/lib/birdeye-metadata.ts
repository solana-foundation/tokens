import 'server-only';

import { proxiedIpfsLogoUrl } from '@/lib/ipfs-ref';

const BIRDEYE_METADATA_URL = 'https://public-api.birdeye.so/defi/v3/token/meta-data/multiple';
// Birdeye caps the exact-mint metadata endpoint at 50 addresses per call.
const BATCH_SIZE = 50;
const CONCURRENCY = 4;
const TIMEOUT_MS = 5_000;

export interface BirdeyeTokenMetadata {
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
}

interface BirdeyeMetadataResponse {
    success?: boolean;
    data?: Record<string, { symbol?: unknown; name?: unknown; logo_uri?: unknown; logoURI?: unknown } | null>;
}

/**
 * Best-effort logo/name fill straight from Birdeye for mints the platform API
 * does not index. Returns an empty map when BIRDEYE_API_KEY is unset; a failed
 * batch just leaves its mints unfilled.
 */
export async function fetchBirdeyeTokenMetadata(mints: readonly string[]): Promise<Map<string, BirdeyeTokenMetadata>> {
    const byMint = new Map<string, BirdeyeTokenMetadata>();
    const apiKey = process.env.BIRDEYE_API_KEY?.trim();
    const unique = [...new Set(mints)];
    if (!apiKey || unique.length === 0) return byMint;

    const batches: string[][] = [];
    for (let index = 0; index < unique.length; index += BATCH_SIZE) {
        batches.push(unique.slice(index, index + BATCH_SIZE));
    }

    let cursor = 0;
    const worker = async () => {
        while (cursor < batches.length) {
            const batch = batches[cursor++]!;
            try {
                const params = new URLSearchParams({ list_address: batch.join(',') });
                const response = await fetch(`${BIRDEYE_METADATA_URL}?${params}`, {
                    headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana', accept: 'application/json' },
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                if (!response.ok) continue;
                const payload = (await response.json()) as BirdeyeMetadataResponse;
                if (!payload.success || !payload.data) continue;
                for (const [mint, item] of Object.entries(payload.data)) {
                    if (!item) continue;
                    byMint.set(mint, {
                        symbol: toText(item.symbol),
                        name: toText(item.name),
                        logoURI: normalizeLogoURI(toText(item.logo_uri) ?? toText(item.logoURI)),
                    });
                }
            } catch {
                // Best-effort: skip the batch.
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    return byMint;
}

function toText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * Provider registries carry raw `ipfs://` refs, public-gateway URLs and the odd
 * upper-cased scheme. IPFS refs go through our image proxy (Pinata gateway);
 * other https URLs pass through; anything else is dropped (next/image is https-only).
 */
export function normalizeLogoURI(value: string | null): string | null {
    if (!value) return null;
    const proxied = proxiedIpfsLogoUrl(value);
    if (proxied) return proxied;
    if (/^https:\/\//i.test(value)) return `https://${value.slice('https://'.length)}`;
    return null;
}
