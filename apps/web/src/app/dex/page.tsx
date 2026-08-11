import type { Metadata } from 'next';
import { Suspense } from 'react';

import { isChainId, type ChainId } from '@/lib/market-data/chains';
import { fetchDexPairs } from '@/lib/market-data/dex-pairs';
import { DexExplorer } from './dex-explorer';

export const metadata: Metadata = {
    title: 'DEX Pairs | Tokens',
    description:
        'Live DEX pools across Solana, Ethereum, Base, BNB Chain, Arbitrum, Stellar and Robinhood — price, volume, depth and trade counts per pair.',
};

const DEFAULT_CHAIN: ChainId = 'solana';

interface DexPageProps {
    searchParams?: Promise<{ chain?: string | string[] }>;
}

export default function DexPage({ searchParams }: DexPageProps) {
    return (
        <main className="min-h-dvh bg-white">
            <Suspense fallback={<DexPairsFallback />}>
                <DexSection searchParams={searchParams} />
            </Suspense>
        </main>
    );
}

/**
 * Streams behind the shell. A cold five-page sweep of one chain takes several
 * seconds through GeckoTerminal's paced keyless tier, and blocking the whole
 * route on it would leave the tab blank for that long.
 */
async function DexSection({ searchParams }: { searchParams: DexPageProps['searchParams'] }) {
    const resolved = (await searchParams) ?? {};
    const raw = Array.isArray(resolved.chain) ? resolved.chain[0] : resolved.chain;
    const chain = raw && isChainId(raw) ? raw : DEFAULT_CHAIN;

    const { pairs, degraded } = await fetchDexPairs(chain);

    return <DexExplorer initialChain={chain} initialPairs={pairs} initialDegraded={degraded} />;
}

function DexPairsFallback() {
    return (
        <div className="mx-auto w-full max-w-[1400px] animate-pulse px-6 py-10">
            <div className="mb-6 h-8 w-40 rounded bg-gray-100" />
            <div className="mb-4 flex gap-2">
                {Array.from({ length: 7 }, (_, index) => (
                    <div key={index} className="h-8 w-24 rounded-full bg-gray-100" />
                ))}
            </div>
            <div className="mb-4 h-9 w-full rounded-lg bg-gray-100" />
            <div className="overflow-hidden rounded-2xl border border-gray-200">
                <div className="h-11 bg-gray-50" />
                {Array.from({ length: 12 }, (_, index) => (
                    <div key={index} className="h-12 border-t border-gray-100 bg-white" />
                ))}
            </div>
        </div>
    );
}
