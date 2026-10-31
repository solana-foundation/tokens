'use client';

import dynamic from 'next/dynamic';
import { PriceChartSkeleton } from '@/app/token/[address]/components/price-chart-skeleton';

interface AssetPriceChartSectionProps {
    assetId: string;
    mint?: string;
    mode?: 'canonical' | 'variant';
    coingeckoId?: string;
    category?: string;
    symbol: string;
    realtimeSymbol?: string;
    tokenName?: string;
    logoURI?: string;
    currentPrice?: number;
    priceChange24h?: number;
    realtimeEnabled?: boolean;
}

const AssetPriceChart = dynamic(() => import('@/components/asset-price-chart').then(m => m.AssetPriceChart), {
    ssr: false,
    loading: () => <PriceChartSkeleton />,
});

export function AssetPriceChartSection({
    assetId,
    mint,
    mode,
    coingeckoId,
    category,
    symbol,
    realtimeSymbol,
    tokenName,
    logoURI,
    currentPrice,
    priceChange24h,
    realtimeEnabled,
}: AssetPriceChartSectionProps) {
    return (
        <AssetPriceChart
            assetId={assetId}
            mint={mint}
            mode={mode}
            coingeckoId={coingeckoId}
            category={category}
            symbol={symbol}
            realtimeSymbol={realtimeSymbol}
            tokenName={tokenName}
            logoURI={logoURI}
            currentPrice={currentPrice}
            priceChange24h={priceChange24h}
            realtimeEnabled={realtimeEnabled}
        />
    );
}
