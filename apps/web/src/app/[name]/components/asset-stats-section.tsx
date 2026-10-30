import type { ReactNode } from 'react';
import { ArrowLeftRight, Info } from 'lucide-react';
import { formatPrice, toEpochMs } from '@/lib/format';
import type { V2AssetStats } from '@/lib/api-v2-types';
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
    /** Unix ms (the v2 `*At` convention). */
    lastTradeAt?: number | null;
    /** Provider timestamp; seconds or ms, normalised on render. */
    asOf?: number | null;
    /** Canonical view: where each headline figure came from (`stats.source`). */
    statsSource?: V2AssetStats['source'];
    /** PreStocks reference data for tokenized pre-IPO exposure. */
    preStocks?: {
        markPriceUsd: number | null;
        markValuationUsd: number | null;
        impliedValuationUsd: number | null;
        premiumToMarkPercent: number | null;
        asOf?: number | null;
    } | null;
}

/** Figures to show when a variant has no market row at all: its own CoinGecko coin, never the asset's. */
export interface AssetStatsFallback {
    price: number | null;
    marketCap: number | null;
    fdv: number | null;
    circulatingSupply: number | null;
    totalSupply: number | null;
    priceChange24h: number | null;
    volume24h: number | null;
}

interface AssetStatsSectionProps {
    market: AssetMarketSnapshot | null;
    /** Variant view only; applied as a whole when `market` is null, never per field. */
    globalStats: AssetStatsFallback | null;
    mode?: 'canonical' | 'variant';
    /** Label of the active variant's chain for the per-variant tooltip copy (default Solana). */
    chainLabel?: string;
    /** "Solana", "Solana and Base", … for the aggregate tooltip copy (default Solana). */
    chainList?: string;
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

export function AssetStatsSection({
    market,
    globalStats,
    mode = 'variant',
    chainLabel = 'Solana',
    chainList = 'Solana',
}: AssetStatsSectionProps) {
    const isCanonical = mode === 'canonical';

    // Canonical: `market` is the reference-first headline, already complete.
    // Variant: the variant's own market row, or, when there is none at all, the
    // variant's own CoinGecko figures as a whole. Never field by field, so a Base
    // row without a market cap does not show the asset's global cap under its symbol.
    const hasMarketRow = Boolean(
        pickPositive(market?.price, null) ??
        pickPositive(market?.liquidity, null) ??
        pickPositive(market?.volume24hUSD, null) ??
        pickPositive(market?.marketCap, null) ??
        pickPositive(market?.fdv, null) ??
        pickPositive(market?.totalSupply, null) ??
        pickPositive(market?.circulatingSupply, null),
    );
    const fallback = !isCanonical && !hasMarketRow ? globalStats : null;
    const usesFallback = fallback !== null;

    const marketCap = pickPositive(usesFallback ? fallback.marketCap : market?.marketCap, null);
    const liquidity = pickPositive(usesFallback ? null : market?.liquidity, null);
    const volume24h = pickPositive(usesFallback ? fallback.volume24h : market?.volume24hUSD, null);
    const underlyingVolume24h =
        isCanonical && market?.underlyingVolume24hUSD !== volume24h
            ? pickPositive(market?.underlyingVolume24hUSD, null)
            : null;
    const circulatingSupply = pickPositive(usesFallback ? fallback.circulatingSupply : market?.circulatingSupply, null);
    const price = pickPositive(usesFallback ? fallback.price : market?.price, null);
    const priceChange24h = pickFinite(usesFallback ? fallback.priceChange24h : market?.priceChange24hPercent, null);
    const fdv = pickPositive(usesFallback ? fallback.fdv : market?.fdv, null);
    const totalSupply = pickPositive(usesFallback ? fallback.totalSupply : market?.totalSupply, null);
    const volume1h = pickPositive(market?.volume1hUSD, null);
    const trade1h = pickPositive(market?.trade1h, null);
    const trade24h = pickPositive(market?.trade24h, null);
    const uniqueWallet24h = pickPositive(market?.uniqueWallet24h, null);
    const lastTradeAt = toEpochMs(market?.lastTradeAt);
    const asOf = toEpochMs(market?.asOf);
    const hasTradeMetrics = Boolean(volume1h ?? trade1h ?? trade24h ?? uniqueWallet24h ?? lastTradeAt ?? asOf);

    const preStocks = market?.preStocks ?? null;
    const impliedValuation = preStocks ? pickPositive(preStocks.impliedValuationUsd, null) : null;
    const markValuation = preStocks ? pickPositive(preStocks.markValuationUsd, null) : null;
    const markPrice = preStocks ? pickPositive(preStocks.markPriceUsd, null) : null;
    const premiumToMark = preStocks ? pickFinite(preStocks.premiumToMarkPercent, null) : null;
    // When the implied valuation is available it takes the headline slot and the
    // token float moves to the FDV slot with an unambiguous label.
    const showImpliedValuation = impliedValuation !== null;
    const tokenizedFloat = pickPositive(market?.marketCap, null);
    const premiumTone: StatCardProps['badgeTone'] =
        premiumToMark === null || Math.abs(premiumToMark) <= 0.05
            ? 'neutral'
            : premiumToMark > 0
              ? 'positive'
              : 'negative';

    const statsSource: V2AssetStats['source'] = market?.statsSource ?? {};
    const onChain = (what: string) =>
        `${what} aggregated across ${chainList} on-chain markets, leaving out stale, dust and outlier rows.`;
    const fromSource = (what: string, key: keyof V2AssetStats['source'], fallbackCopy: string) => {
        const kind = statsSource[key];
        if (kind === 'coingecko') return `${what} from CoinGecko (global, all venues).`;
        if (kind === 'stock') return `${what} from the stock market reference.`;
        if (kind === 'onchain') return onChain(what);
        return fallbackCopy;
    };
    const variantCopy = (what: string) =>
        usesFallback
            ? `${what} from this token's own CoinGecko listing; no ${chainLabel} market data is available.`
            : `${what} from ${chainLabel} markets.`;
    const tooltips =
        mode === 'canonical'
            ? {
                  marketCap:
                      market?.marketCapSource === 'company'
                          ? 'Company market cap (stock price × shares outstanding).'
                          : fromSource('Market cap', 'marketCap', onChain('Market cap')),
                  liquidity: onChain('Liquidity'),
                  volume24h: `${onChain('24h DEX volume')} For crypto and stock assets, the provider's all-venue volume appears as a secondary pill.`,
                  price: fromSource('Price', 'price', onChain('Price')),
                  priceChange24h: fromSource('24h price change', 'priceChange24hPercent', onChain('24h price change')),
                  fdv: fromSource('FDV', 'fdv', onChain('FDV')),
                  totalSupply: fromSource('Total supply', 'totalSupply', onChain('Total supply (issued variants only)')),
                  supply: fromSource('Circulating supply', 'circulatingSupply', onChain('Circulating supply (issued variants only)')),
              }
            : {
                  marketCap: variantCopy('Market cap'),
                  liquidity: `Liquidity in ${chainLabel} DEX pools.`,
                  volume24h: usesFallback ? variantCopy('24h volume') : `Volume on ${chainLabel} DEX pools in the last 24 hours.`,
                  price: variantCopy('Price'),
                  priceChange24h: variantCopy('24h price change'),
                  fdv: variantCopy('Fully diluted valuation'),
                  totalSupply: variantCopy('Total supply'),
                  supply: variantCopy('Circulating supply'),
              };

    return (
        <div className="my-8">
            <div className="flex flex-wrap items-center gap-3 mb-6 mt-12">
                <h3 className="text-title-md text-text-extra-high text-balance">Stats</h3>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 overflow-hidden mb-px [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                {showImpliedValuation ? (
                    <StatCard
                        label="Implied Valuation"
                        tooltip={
                            <div className="max-w-[260px]">
                                <p>
                                    Company valuation implied by the token&apos;s market price: PreStocks reference
                                    valuation × token price ÷ reference (mark) price.
                                </p>
                                <p className="mt-1 text-white/80">
                                    Reference data from PreStocks — not an official company valuation.
                                </p>
                            </div>
                        }
                        value={formatUsd(impliedValuation)}
                        badge={markValuation !== null ? `${formatUsd(markValuation)} mark` : undefined}
                    />
                ) : (
                    <StatCard label="Market Cap" tooltip={tooltips.marketCap} value={formatUsd(marketCap)} />
                )}
                <StatCard label="Liquidity" tooltip={tooltips.liquidity} value={formatUsd(liquidity)} />
                <StatCard
                    label="24H Volume"
                    tooltip={
                        underlyingVolume24h !== null ? (
                            <CanonicalVolumeTooltipContent chainList={chainList} label={market?.underlyingVolume24hLabel ?? null} />
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
                <StatCard
                    label="Price"
                    tooltip={
                        premiumToMark !== null ? (
                            <div className="max-w-[260px]">
                                <p>Token price from {chainLabel} markets.</p>
                                <p className="mt-1 text-white/80">
                                    The chip shows the token&apos;s premium or discount to the PreStocks reference
                                    (mark) price{markPrice !== null ? ` of ${formatPrice(markPrice)}` : ''}.
                                </p>
                            </div>
                        ) : (
                            tooltips.price
                        )
                    }
                    value={formatPrice(price)}
                    badge={premiumToMark !== null ? `${formatPercent(premiumToMark)} vs mark` : undefined}
                    badgeTone={premiumToMark !== null ? premiumTone : undefined}
                />
                <StatCard label="24H Change" tooltip={tooltips.priceChange24h} value={formatPercent(priceChange24h)} />
                {showImpliedValuation ? (
                    <StatCard
                        label="Tokenized Float"
                        tooltip={`Value of the issued ${chainLabel} token float (token price × issued token supply). This is the tokenized float, not the company's valuation.`}
                        value={formatUsd(tokenizedFloat)}
                    />
                ) : (
                    <StatCard label="FDV" tooltip={tooltips.fdv} value={formatUsd(fdv)} />
                )}
                <StatCard label="Total Supply" tooltip={tooltips.totalSupply} value={formatNumber(totalSupply)} />
            </div>

            {hasTradeMetrics ? (
                <div className="grid grid-cols-2 md:grid-cols-4 border-t border-border-light overflow-hidden [&>*]:border-border-light [&>*:nth-child(even)]:border-l md:[&>*:nth-child(n+2)]:border-l max-md:[&>*:nth-child(n+3)]:border-t">
                    <StatCard
                        label="1H Volume"
                        tooltip={`USD volume from direct stable-pair ${chainLabel} trades in the last hour.`}
                        value={formatUsd(volume1h)}
                    />
                    <StatCard
                        label="1H Trades"
                        tooltip={
                            <TradeMetricTooltipContent lastTradeAt={lastTradeAt} asOf={asOf}>
                                Successful direct stable-pair {chainLabel} trades in the last hour.
                            </TradeMetricTooltipContent>
                        }
                        value={formatInteger(trade1h)}
                    />
                    <StatCard
                        label="24H Trades"
                        tooltip={
                            <TradeMetricTooltipContent lastTradeAt={lastTradeAt} asOf={asOf}>
                                Successful direct stable-pair {chainLabel} trades in the last 24 hours.
                            </TradeMetricTooltipContent>
                        }
                        value={formatInteger(trade24h)}
                    />
                    <StatCard
                        label="24H Wallets"
                        tooltip={`Unique trader wallets in direct stable-pair ${chainLabel} trades over the last 24 hours.`}
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
    badgeTone?: 'positive' | 'negative' | 'neutral';
}

const BADGE_TONE_CLASSES: Record<NonNullable<StatCardProps['badgeTone']>, string> = {
    positive: 'bg-green-50 text-green-800 hover:bg-green-100',
    negative: 'bg-red-50 text-red-800 hover:bg-red-100',
    neutral: 'bg-[#F2F3F5] text-text-medium hover:bg-[#E8EAED]',
};

function StatCard({ label, tooltip, value, badge, badgeTone }: StatCardProps) {
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
                    <span
                        className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-none opacity-55 tabular-nums transition-[background-color,opacity] hover:opacity-100 ${BADGE_TONE_CLASSES[badgeTone ?? 'neutral']}`}
                    >
                        {badge}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

function CanonicalVolumeTooltipContent({ chainList, label }: { chainList: string; label: string | null }) {
    return (
        <div className="max-w-[260px]">
            <p>{label ? `${label}: all-venue 24h volume from the reference provider.` : '24h volume from the reference provider (all venues).'}</p>
            <p className="mt-1 text-white/80">
                The main number is 24h DEX volume aggregated across {chainList} on-chain markets, leaving out stale, dust
                and outlier rows.
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
                        {lastTradeAt ? <span>Last trade {formatEpochMs(lastTradeAt)}</span> : null}
                        {lastTradeAt && asOf ? <span className="px-1.5 text-white/50">/</span> : null}
                        {asOf ? <span>As of {formatEpochMs(asOf)}</span> : null}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

function formatInteger(value: number | undefined | null): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString();
}

const epochFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});

/** `value` is already milliseconds (see `toEpochMs`); the old formatter multiplied v2's ms `lastTradeAt` by 1000. */
function formatEpochMs(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '—';
    return epochFormatter.format(new Date(value));
}
