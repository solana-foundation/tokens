'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';

import { InlinePriceChart } from '@/components/inline-price-chart';
import { useInlineLatestClose } from '@/hooks/queries/use-inline-latest-close';
import { formatLargeNumber, formatPrice } from '@/lib/format';
import { trackEvent } from '@/lib/posthog-client';
import { cn } from '@tokens/ui/cn';
import { IconTriangleFill } from 'symbols-react';
import { cleanTokenName, getTokenLogoURLWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { looksLikeSolanaMintAddress } from '@/lib/solana-address';
import type { HomeHighlightCard as HighlightCard, HomeHighlightCards } from '@/lib/home-highlights';
import type { Token } from '@/lib/types';

interface HighlightsSectionProps {
    cards: HomeHighlightCards;
}

const INLINE_CHART_FALLBACK_DAYS = 7;

export function HighlightsSection({ cards }: HighlightsSectionProps) {
    return (
        <section className="mx-auto max-w-7xl px-6 pb-10 md:pb-12">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {cards.map(card => (
                    // Key on the token too, so a tab switch remounts the card (fresh
                    // chart + scrub state) instead of morphing the previous token.
                    <HighlightStatCard key={`${card.id}:${card.token.assetId ?? card.token.address}`} card={card} />
                ))}
            </div>
        </section>
    );
}

function inferStartPriceFromPercentChange(currentPrice: number, percentChange: number): number | null {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
    if (!Number.isFinite(percentChange)) return null;
    const denom = 1 + percentChange / 100;
    if (!Number.isFinite(denom) || denom === 0) return null;
    const start = currentPrice / denom;
    return Number.isFinite(start) && start > 0 ? start : null;
}

function HighlightStatCard({ card }: { card: HighlightCard }) {
    const [scrubbedPrice, setScrubbedPrice] = useState<number | null>(null);
    const chartPointerStateRef = useRef<{
        startX: number;
        startY: number;
        isPointerDown: boolean;
        didDrag: boolean;
    }>({ startX: 0, startY: 0, isPointerDown: false, didDrag: false });

    const handleScrub = useCallback((price: number | null) => {
        setScrubbedPrice(prev => (prev === price ? prev : price));
    }, []);

    const latestClose = useInlineLatestClose({
        assetId: card.token.assetId,
        address: card.token.address,
        fallbackDays: INLINE_CHART_FALLBACK_DAYS,
    });

    const href = useMemo(() => {
        const assetId = card.token.assetId?.trim() ?? '';
        if (assetId) return `/${encodeURIComponent(assetId)}`;

        const mint = (card.token.address ?? '').trim();
        if (looksLikeSolanaMintAddress(mint)) return `/token/${encodeURIComponent(mint)}`;

        return null;
    }, [card.token.address, card.token.assetId]);

    const isPercentMetric = card.metric === 'gainer24h';

    const startPrice = useMemo(() => {
        return inferStartPriceFromPercentChange(card.token.price, card.token.priceChange24hPercent);
    }, [card.token.price, card.token.priceChange24hPercent]);

    const scrubbedPercentChange = useMemo(() => {
        if (!isPercentMetric) return null;
        if (scrubbedPrice === null) return null;

        if (startPrice === null) return null;

        return ((scrubbedPrice - startPrice) / startPrice) * 100;
    }, [isPercentMetric, scrubbedPrice, startPrice]);

    const idlePercentChange = useMemo(() => {
        if (!isPercentMetric) return card.token.priceChange24hPercent;
        if (latestClose === null) return card.token.priceChange24hPercent;
        if (startPrice === null) return card.token.priceChange24hPercent;
        return ((latestClose - startPrice) / startPrice) * 100;
    }, [isPercentMetric, card.token.priceChange24hPercent, latestClose, startPrice]);

    const effectivePercentChange = scrubbedPercentChange ?? idlePercentChange;
    const isPositive = effectivePercentChange >= 0;

    const effectivePrice = latestClose ?? card.token.price;

    const metricValue =
        card.metric === 'price'
            ? formatPrice(scrubbedPrice ?? effectivePrice)
            : card.metric === 'volume1h'
              ? scrubbedPrice === null
                  ? formatLargeNumber(card.token.volume1hUSD)
                  : formatPrice(scrubbedPrice)
            : card.metric === 'volume24h'
              ? scrubbedPrice === null
                  ? formatLargeNumber(card.token.volume24hUSD)
                  : formatPrice(scrubbedPrice)
              : null;
    const metricClass = isPercentMetric ? (isPositive ? 'text-emerald-700' : 'text-red-600') : 'text-text-extra-high';

    const content = (
        <article className="rounded-[22px] bg-border-light/30">
            <p className="text-[15px] text-text-high p-3 pl-[24px] py-[10px] pb-0">{card.title}</p>

            <div className="mt-3 rounded-[22px] border border-border-medium bg-white p-[24px] hover:ring-2 hover:ring-border-medium/80 transition-[box-shadow,transform] duration-150 ease-out motion-reduce:transition-none active:scale-[0.98]">
                <div
                    className="h-32 w-full"
                    onPointerDown={event => {
                        const state = chartPointerStateRef.current;
                        state.isPointerDown = true;
                        state.didDrag = false;
                        state.startX = event.clientX;
                        state.startY = event.clientY;
                    }}
                    onPointerMove={event => {
                        const state = chartPointerStateRef.current;
                        if (!state.isPointerDown || state.didDrag) return;

                        const dx = Math.abs(event.clientX - state.startX);
                        const dy = Math.abs(event.clientY - state.startY);
                        if (dx >= 6 || dy >= 6) state.didDrag = true;
                    }}
                    onPointerUp={() => {
                        chartPointerStateRef.current.isPointerDown = false;
                    }}
                    onPointerCancel={() => {
                        chartPointerStateRef.current.isPointerDown = false;
                    }}
                    onClick={event => {
                        // Allow normal clicks to navigate, but prevent navigation after a drag scrub
                        // (primarily for touch devices).
                        const state = chartPointerStateRef.current;
                        if (!state.didDrag) return;
                        state.didDrag = false;
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    <InlinePriceChart
                        assetId={card.token.assetId}
                        coingeckoId={card.token.coingeckoId}
                        useCanonicalAssetChart={card.token.canonicalMarketSource === 'clickhouse_stock'}
                        address={card.token.address}
                        percentChange24h={card.token.priceChange24hPercent}
                        symbol={card.token.symbol}
                        className="h-full w-full rounded-sm overflow-hidden bg-transparent relative"
                        chartHeight={80}
                        onScrub={handleScrub}
                        fallbackDays={INLINE_CHART_FALLBACK_DAYS}
                    />
                </div>

                <div className="mt-1 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <TokenLogo token={card.token} />
                        <span className="truncate text-[22px] leading-none text-text-extra-high">
                            {cleanTokenName(card.token.name)}
                        </span>
                    </div>

                    <span className={`shrink-0 tabular-nums text-[18px] leading-none font-medium ${metricClass}`}>
                        {isPercentMetric ? (
                            <span className="inline-flex items-center gap-1">
                                <IconTriangleFill
                                    className={cn('size-2.5 fill-current', !isPositive && 'rotate-180')}
                                    aria-hidden
                                />
                                {`${Math.abs(effectivePercentChange).toFixed(2)}%`}
                            </span>
                        ) : (
                            metricValue
                        )}
                    </span>
                </div>
            </div>
        </article>
    );

    if (!href) return content;

    return (
        <Link
            href={href}
            className="block cursor-pointer"
            aria-label={`View ${card.token.name}`}
            onClick={() =>
                trackEvent('highlight_clicked', {
                    highlight_type: card.metric,
                    card_id: card.id,
                    ...(card.token.address ? { token_address: card.token.address } : {}),
                    ...(card.token.symbol ? { token_symbol: card.token.symbol } : {}),
                    ...(card.token.assetId ? { asset_id: card.token.assetId } : {}),
                    link_url: href,
                    source: 'home_highlights',
                })
            }
        >
            {content}
        </Link>
    );
}

function TokenLogo({ token }: { token: Token }) {
    const [hasError, setHasError] = useState(false);
    const symbol = token.symbol?.trim() || token.name?.trim() || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const resolvedLogoURI = normalizeLogoSrc(getTokenLogoURLWithSecondarySymbol(token.symbol, token.name, token.logoURI));

    if (!resolvedLogoURI || hasError) {
        return (
            <div className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-gray-100 ring-1 ring-border-light text-[10px] font-medium text-text-medium">
                {initials}
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={symbol}
            width={26}
            height={26}
            className="size-6.5 shrink-0 rounded-full ring-2 ring-border-light bg-gray-50 object-cover"
            loading="lazy"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}
