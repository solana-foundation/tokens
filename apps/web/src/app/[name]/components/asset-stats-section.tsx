import type { ReactNode } from 'react';
import { ArrowLeftRight, Info } from 'lucide-react';
import { formatPrice } from '@/lib/format';
import type { GlobalTokenStats } from '@/lib/coingecko';
import { Tooltip } from '@solana/design-system/tooltip';
import { formatNumber, formatPercent, formatUsd } from '@/app/token/[address]/lib/format';

interface AssetMarketSnapshot {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    underlyingVolume24hUSD?: number | null;
    underlyingVolume24hLabel?: string | null;
    trade1h?: number | null;
    trade24h?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    /** Set to 'company' when marketCap is the underlying company's (price × shares outstanding). */
    marketCapSource?: 'company';
    fdv?: number | null;
    totalSupply?: number | null;
    circulatingSupply?: number | null;
    priceChange24hPercent: number | null;
    lastTradeAt?: number | null;
    asOf?: number | null;
}

interface AssetStatsSectionProps {
    market: AssetMarketSnapshot | null;
    globalStats: GlobalTokenStats | null;
    mode?: 'canonical' | 'variant';
}

function pickPositive(primary: number | undefined | null, fallback: number | undefined | null): number | null {
    const a = typeof primary === 'number' && Number.isFinite(primary) && primary > 0 ? primary : null;
    if (a !== null) return a;
    const b = typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : null;
    return b;
}

function pickFinite(primary: number | undefined | null, fallback: number | undefined | null): number | null {
    const a = typeof primary === 'number' && Number.isFinite(primary) ? primary : null;
    if (a !== null) return a;
    const b = typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : null;
    return b;
}

export function AssetStatsSection({ market, globalStats, mode = 'variant' }: AssetStatsSectionProps) {
    const isCanonical = mode === 'canonical';

    const hasSolanaData = Boolean(
        pickPositive(market?.price, null) ??
        pickPositive(market?.liquidity, null) ??
        pickPositive(market?.volume24hUSD, null) ??
        pickPositive(market?.marketCap, null) ??
        pickPositive(market?.fdv, null) ??
        pickPositive(market?.totalSupply, null) ??
        pickPositive(market?.circulatingSupply, null),
    );

    const marketCap = isCanonical
        ? pickPositive(market?.marketCap, globalStats?.marketCap)
        : pickPositive(hasSolanaData ? market?.marketCap : null, globalStats?.marketCap);

    const liquidity = isCanonical
        ? pickPositive(market?.liquidity, null)
        : pickPositive(hasSolanaData ? market?.liquidity : null, null);

    const volume24h = isCanonical
        ? pickPositive(market?.volume24hUSD, globalStats?.volume24h)
        : pickPositive(hasSolanaData ? market?.volume24hUSD : null, globalStats?.volume24h);
    const underlyingVolume24h =
        isCanonical && market?.underlyingVolume24hUSD !== volume24h
            ? pickPositive(market?.underlyingVolume24hUSD, null)
            : null;

    const circulatingSupply = isCanonical
        ? pickPositive(market?.circulatingSupply, globalStats?.circulatingSupply)
        : pickPositive(hasSolanaData ? market?.circulatingSupply : null, globalStats?.circulatingSupply);

    const price = isCanonical
        ? pickPositive(market?.price, globalStats?.price)
        : pickPositive(hasSolanaData ? market?.price : null, globalStats?.price);

    const priceChange24h = isCanonical
        ? pickFinite(market?.priceChange24hPercent, globalStats?.priceChange24h)
        : pickFinite(hasSolanaData ? market?.priceChange24hPercent : null, globalStats?.priceChange24h);

    const fdv = isCanonical
        ? pickPositive(market?.fdv, globalStats?.fdv)
        : pickPositive(hasSolanaData ? market?.fdv : null, globalStats?.fdv);
    const totalSupply = isCanonical
        ? pickPositive(market?.totalSupply, globalStats?.totalSupply)
        : pickPositive(hasSolanaData ? market?.totalSupply : null, globalStats?.totalSupply);
    const volume1h = pickPositive(market?.volume1hUSD, null);
    const trade1h = pickPositive(market?.trade1h, null);
    const trade24h = pickPositive(market?.trade24h, null);
    const uniqueWallet24h = pickPositive(market?.uniqueWallet24h, null);
    const lastTradeAt = pickPositive(market?.lastTradeAt, null);
    const asOf = pickPositive(market?.asOf, null);
    const hasTradeMetrics = Boolean(volume1h ?? trade1h ?? trade24h ?? uniqueWallet24h ?? lastTradeAt ?? asOf);

    const tooltips =
        mode === 'canonical'
            ? {
                  marketCap:
                      market?.marketCapSource === 'company'
                          ? 'Company market cap (stock price × shares outstanding).'
                          : 'Market cap from aggregated variant data. Falls back to CoinGecko when unavailable.',
                  liquidity: 'Aggregate liquidity across available Solana variant markets.',
                  volume24h:
                      'Aggregate 24h volume across available on-chain variant markets. For crypto and stock assets, supported canonical provider volume appears as a secondary pill.',
                  price: 'Current price from aggregated variant data. Falls back to CoinGecko when unavailable.',
                  priceChange24h:
                      '24h price change from aggregated variant data. Falls back to CoinGecko when unavailable.',
                  fdv: 'FDV from aggregated variant data. Falls back to CoinGecko when unavailable.',
                  totalSupply: 'Total supply from aggregated variant data. Falls back to CoinGecko when unavailable.',
                  supply: 'Circulating supply from aggregated variant data. Falls back to CoinGecko when unavailable.',
              }
            : {
                  marketCap: 'Market cap from Solana markets. Falls back to global data when Solana is unavailable.',
                  liquidity: 'Liquidity in Solana DEX pools.',
                  volume24h:
                      'Volume on Solana DEX pools in the last 24 hours. Falls back to global data when Solana is unavailable.',
                  price: 'Current price from Solana markets. Falls back to global data when Solana is unavailable.',
                  priceChange24h:
                      '24h price change from Solana markets. Falls back to global data when Solana is unavailable.',
                  fdv: 'Fully diluted valuation from Birdeye. Falls back to global data when Solana is unavailable.',
                  totalSupply: 'Total supply from Birdeye. Falls back to global data when Solana is unavailable.',
                  supply: 'Circulating supply from Birdeye. Falls back to global data when Solana is unavailable.',
              };

    return (
        <div className="my-8">
            <div className="flex flex-wrap items-center gap-3 mb-6 mt-12">
                <h3 className="text-title-md text-text-extra-high text-balance">Stats</h3>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 overflow-hidden mb-px [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                <StatCard label="Market Cap" tooltip={tooltips.marketCap} value={formatUsd(marketCap)} />
                <StatCard label="Liquidity" tooltip={tooltips.liquidity} value={formatUsd(liquidity)} />
                <StatCard
                    label="24H Volume"
                    tooltip={
                        underlyingVolume24h !== null ? (
                            <CanonicalVolumeTooltipContent />
                        ) : (
                            tooltips.volume24h
                        )
                    }
                    value={formatUsd(volume24h)}
                    badge={underlyingVolume24h !== null ? formatUsd(underlyingVolume24h) : undefined}
                />
                <StatCard label="Supply" tooltip={tooltips.supply} value={formatNumber(circulatingSupply)} />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 border-t border-border-light overflow-hidden [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                <StatCard label="Price" tooltip={tooltips.price} value={formatPrice(price)} />
                <StatCard label="24H Change" tooltip={tooltips.priceChange24h} value={formatPercent(priceChange24h)} />
                <StatCard label="FDV" tooltip={tooltips.fdv} value={formatUsd(fdv)} />
                <StatCard label="Total Supply" tooltip={tooltips.totalSupply} value={formatNumber(totalSupply)} />
            </div>

            {hasTradeMetrics ? (
                <div className="grid grid-cols-2 md:grid-cols-4 border-t border-border-light overflow-hidden [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                    <StatCard
                        label="1H Volume"
                        tooltip="USD volume from direct stable-pair Solana trades in the last hour."
                        value={formatUsd(volume1h)}
                    />
                    <StatCard
                        label="1H Trades"
                        tooltip={
                            <TradeMetricTooltipContent lastTradeAt={lastTradeAt} asOf={asOf}>
                                Successful direct stable-pair Solana trades in the last hour.
                            </TradeMetricTooltipContent>
                        }
                        value={formatInteger(trade1h)}
                    />
                    <StatCard
                        label="24H Trades"
                        tooltip={
                            <TradeMetricTooltipContent lastTradeAt={lastTradeAt} asOf={asOf}>
                                Successful direct stable-pair Solana trades in the last 24 hours.
                            </TradeMetricTooltipContent>
                        }
                        value={formatInteger(trade24h)}
                    />
                    <StatCard
                        label="24H Wallets"
                        tooltip="Unique trader wallets in direct stable-pair Solana trades over the last 24 hours."
                        value={formatInteger(uniqueWallet24h)}
                    />
                </div>
            ) : null}
        </div>
    );
}

interface StatCardProps {
    label: string;
    tooltip: ReactNode;
    value: string;
    badge?: string;
}

function StatCard({ label, tooltip, value, badge }: StatCardProps) {
    return (
        <div className="pl-6 pr-6 py-5 first:pl-0 max-md:odd:pl-0">
            <div className="flex items-center gap-1.5 mb-2">
                <span className="text-body-md text-text-medium">{label}</span>
                <Tooltip content={tooltip} side="top" align="center">
                    <button
                        type="button"
                        aria-label={`More info about ${label}`}
                        className="text-text-extra-low hover:text-text-low transition-colors"
                    >
                        <Info className="h-3 w-3" />
                    </button>
                </Tooltip>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-title-sm text-text-extra-high">{value}</p>
                {badge ? (
                    <span className="inline-flex max-w-full items-center rounded-full bg-[#F2F3F5] px-2 py-0.5 text-[11px] font-semibold leading-none text-text-medium opacity-55 tabular-nums transition-[background-color,opacity] hover:bg-[#E8EAED] hover:opacity-100">
                        {badge}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

function CanonicalVolumeTooltipContent() {
    return (
        <div className="max-w-[260px]">
            <p>Canonical crypto 24h volume from CoinGecko.</p>
            <p className="mt-1 text-white/80">
                The main number is aggregate on-chain volume across available Solana variant markets.
            </p>
        </div>
    );
}

function TradeMetricTooltipContent({
    children,
    lastTradeAt,
    asOf,
}: {
    children: ReactNode;
    lastTradeAt: number | null;
    asOf: number | null;
}) {
    const hasTimestamps = Boolean(lastTradeAt || asOf);

    return (
        <div className="max-w-[260px]">
            <p>{children}</p>
            {hasTimestamps ? (
                <div className="mt-2 flex items-start gap-1.5 border-t border-white/20 pt-2 text-white/80">
                    <ArrowLeftRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span className="leading-snug">
                        {lastTradeAt ? <span>Last trade {formatUnixSeconds(lastTradeAt)}</span> : null}
                        {lastTradeAt && asOf ? <span className="px-1.5 text-white/50">/</span> : null}
                        {asOf ? <span>As of {formatUnixSeconds(asOf)}</span> : null}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

function formatInteger(value: number | undefined | null): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString('en-US');
}

const unixSecondsFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});

function formatUnixSeconds(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return unixSecondsFormatter.format(new Date(value * 1000));
}
