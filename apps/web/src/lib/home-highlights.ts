import type { CuratedTokenListIdWithoutLsts } from '@/lib/curated-token-lists';
import type { Token } from '@/lib/types';

export type HomeTabId = 'trending' | CuratedTokenListIdWithoutLsts;

export interface HomeHighlightCard {
    id: string;
    title: string;
    token: Token;
    metric: 'price' | 'volume1h' | 'volume24h' | 'gainer24h';
}

export type HomeHighlightCards = readonly [HomeHighlightCard, HomeHighlightCard, HomeHighlightCard];

/**
 * Global home highlights, computed across every curated asset (all lists combined) —
 * intentionally independent of whichever tab/table is selected.
 */
export function createHomeHighlights(tokens: Token[], lastAddedAssetId: string | null): HomeHighlightCards {
    const fallback = createFallbackToken();

    if (tokens.length === 0) {
        return [
            { id: 'latest-added', title: 'Latest Added', token: fallback, metric: 'price' },
            { id: 'highest-volume-24h', title: 'Highest Volume (24H)', token: fallback, metric: 'volume24h' },
            { id: 'biggest-gainer-24h', title: 'Biggest Gainer (24H)', token: fallback, metric: 'gainer24h' },
        ];
    }

    const latestAdded =
        lastAddedAssetId !== null
            ? (tokens.find(token => (token.assetId ?? '').trim() === lastAddedAssetId) ?? null)
            : null;

    const hasVolume = (token: Token) => Number.isFinite(token.volume24hUSD) && token.volume24hUSD > 0;

    // Exclude SOL itself and stablecoins (USD & friends would win every day — we want
    // this card to show movement). Falls back to the full pool if the filter empties it.
    const isExcludedFromHighestVolume = (token: Token) =>
        (token.assetId ?? '').trim() === 'solana' || token.category === 'stablecoin';
    const highestVolumeCandidates = tokens.filter(token => !isExcludedFromHighestVolume(token) && hasVolume(token));

    // Ranking on-chain volume against an exchange's traded value picks whichever
    // market is simply bigger — a leveraged QQQ ETF turns over billions on NASDAQ
    // and nothing on any DEX. When any row carries a DEX figure, only those
    // compete; otherwise every row is on the same footing and all of them do.
    const onChainCandidates = highestVolumeCandidates.filter(token => token.volume24hSource === 'onchain');
    const highestVolumeSource =
        onChainCandidates.length > 0
            ? onChainCandidates
            : highestVolumeCandidates.length > 0
              ? highestVolumeCandidates
              : tokens;
    const highestVolume = highestVolumeSource.reduce(
        (best, token) => (token.volume24hUSD > best.volume24hUSD ? token : best),
        highestVolumeSource[0],
    );
    const biggestGainer = tokens.reduce(
        (best, token) => (token.priceChange24hPercent > best.priceChange24hPercent ? token : best),
        tokens[0],
    );
    return [
        { id: 'latest-added', title: 'Latest Added', token: latestAdded ?? fallback, metric: 'price' },
        {
            id: 'highest-volume-24h',
            title: 'Highest Volume (24H)',
            token: highestVolume ?? fallback,
            metric: 'volume24h',
        },
        {
            id: 'biggest-gainer-24h',
            title: 'Biggest Gainer (24H)',
            token: biggestGainer ?? fallback,
            metric: 'gainer24h',
        },
    ];
}

export function createFallbackToken(): Token {
    return {
        address: 'fallback',
        name: 'Token',
        symbol: 'TKN',
        decimals: 9,
        liquidity: 0,
        volume24hUSD: 0,
        price: 0,
        priceChange24hPercent: 0,
        marketCap: 0,
    };
}
