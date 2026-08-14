import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { CHAINS, isChainId } from '@/lib/market-data/chains';
import { fetchDexPairDetail, fetchPoolCandles } from '@/lib/market-data/dex-pair-detail';
import { PairDetail } from './pair-detail';

interface PairPageProps {
    params: Promise<{ chain: string; pair: string }>;
}

export async function generateMetadata({ params }: PairPageProps): Promise<Metadata> {
    const { chain, pair } = await params;
    if (!isChainId(chain)) return { title: 'Pair | Tokens' };

    const detail = await fetchDexPairDetail(chain, pair);
    if (!detail) return { title: 'Pair | Tokens' };

    const label = `${detail.base.symbol} / ${detail.quote.symbol}`;
    return {
        title: `${label} on ${CHAINS[chain].label} | Tokens`,
        description: `Live price, depth, volume and trade activity for the ${label} pool on ${CHAINS[chain].label}.`,
    };
}

export default function PairPage({ params }: PairPageProps) {
    return (
        <main className="min-h-dvh bg-white">
            <Suspense fallback={<PairFallback />}>
                <PairSection params={params} />
            </Suspense>
        </main>
    );
}

async function PairSection({ params }: PairPageProps) {
    const { chain, pair } = await params;
    if (!isChainId(chain)) notFound();

    // Pool data is live and cached against the wall clock, so this route opts
    // out of prerendering for the same reason the pair list does.
    await connection();

    const detail = await fetchDexPairDetail(chain, pair);
    if (!detail) notFound();

    // The default window renders server-side so the chart is not empty on first
    // paint; other ranges are fetched by the client on demand.
    const candles = await fetchPoolCandles(chain, detail.address, 7);

    return <PairDetail pair={detail} initialCandles={candles} initialDays={7} />;
}

function PairFallback() {
    return (
        <div className="mx-auto w-full max-w-[1120px] animate-pulse px-6 pt-28">
            <div className="h-5 w-32 rounded bg-gray-100" />
            <div className="mt-6 h-10 w-64 rounded bg-gray-100" />
            <div className="mt-3 h-8 w-40 rounded bg-gray-100" />
            <div className="mt-8 h-[360px] rounded-2xl bg-gray-100" />
            <div className="mt-8 grid grid-cols-2 gap-px md:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                    <div key={index} className="h-20 bg-gray-100" />
                ))}
            </div>
        </div>
    );
}
