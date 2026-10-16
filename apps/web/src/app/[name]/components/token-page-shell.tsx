import type { ReactNode } from 'react';
import Link from 'next/link';

import { cn } from '@tokens/ui/cn';

import { TokenBreadcrumb } from '@/app/token/[address]/components/token-breadcrumb';
import { SwapProvidersDropdown } from '@/app/token/[address]/components/swap-providers-dropdown';
import { ExpandableText } from '@/components/expandable-text';
import { FloatingMarketFeedPageContext } from '@/components/floating-market-feed-context';
import { SiteFooter } from '@/components/site-footer';
import { isTradeBlocked, type AssetAdvisory } from '@/lib/asset-advisory';

export interface TokenPageBackgroundBlurProps {
    children: ReactNode;
}

export function TokenPageBackgroundBlur({ children }: TokenPageBackgroundBlurProps) {
    return (
        <div className="absolute top-[-400px] left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none z-0">
            <div className="relative w-[2000px] h-[1500px]">{children}</div>
        </div>
    );
}

export interface TokenPageSidebarProps {
    buyAddress: string | null;
    buySymbol?: string;
    buyLogoURI?: string;
    displayName: string;
    description: string | null;
    tokenFeedCoinId?: string;
    tokenFeedTerms?: string[];
    /** Advisory on the viewed mint; gates the Buy CTA and description anchors. */
    advisory?: AssetAdvisory | null;
    /** When the active variant's chain cannot swap: link to the asset's primary variant on a chain that can. */
    tradeOnChainHref?: string | null;
    tradeOnChainLabel?: string | null;
}

/** Fallback CTA for variants on chains without swap support (e.g. an EVM view of a Solana-tradeable asset). */
export function TradeOnChainLink({
    href,
    displayName,
    chainLabel,
}: {
    href: string;
    displayName: string;
    chainLabel: string;
}) {
    return (
        <Link
            href={href}
            className="flex w-full items-center justify-center rounded-full bg-text-extra-high px-5 py-3 text-[15px] font-medium text-white transition-opacity hover:opacity-90"
        >
            Trade {displayName} on {chainLabel}
        </Link>
    );
}

export function TokenPageSidebar({
    buyAddress,
    buySymbol,
    buyLogoURI,
    displayName,
    description,
    tokenFeedCoinId,
    tokenFeedTerms,
    advisory = null,
    tradeOnChainHref = null,
    tradeOnChainLabel = null,
}: TokenPageSidebarProps) {
    return (
        <>
            <div className="space-y-8">
                {!buyAddress && tradeOnChainHref && tradeOnChainLabel && (
                    <div className="hidden lg:sticky lg:top-24 lg:z-20 lg:block">
                        <TradeOnChainLink
                            href={tradeOnChainHref}
                            displayName={displayName}
                            chainLabel={tradeOnChainLabel}
                        />
                    </div>
                )}
                {buyAddress && (
                    <div className="hidden lg:sticky lg:top-24 lg:z-20 lg:block">
                        <SwapProvidersDropdown
                            buyAddress={buyAddress}
                            buyName={displayName}
                            buySymbol={buySymbol}
                            buyLogoURI={buyLogoURI}
                            advisory={advisory}
                        />
                    </div>
                )}

                {description && description.trim().length > 0 && (
                    <section>
                        <h2 className="text-balance text-title-sm text-text-extra-high mb-4">About {displayName}</h2>
                        <ExpandableText text={description} allowLinks={!isTradeBlocked(advisory)} />
                    </section>
                )}
            </div>

            <FloatingMarketFeedPageContext
                displayName={displayName}
                tokenLogoURI={buyLogoURI}
                tokenSymbol={buySymbol}
                tokenFeedCoinId={tokenFeedCoinId}
                tokenFeedTerms={tokenFeedTerms}
                hasMobileBottomBar={Boolean(buyAddress) || Boolean(tradeOnChainHref)}
            />
        </>
    );
}

export interface TokenPageScaffoldProps {
    viewedEvent?: ReactNode;
    background?: ReactNode;
    displayName: string;
    breadcrumbCanonicalHref?: string;
    breadcrumbVariantSymbol?: string;
    buyAddress: string | null;
    buySymbol?: string;
    buyLogoURI?: string;
    /** Advisory on the viewed mint; threaded to the mobile bottom-bar CTA. */
    advisory?: AssetAdvisory | null;
    /** Rendered immediately above the header (advisory banner / sibling notice). */
    advisoryBanner?: ReactNode;
    /** Mobile bottom-bar fallback when the active chain cannot swap (see TokenPageSidebar). */
    tradeOnChainHref?: string | null;
    tradeOnChainLabel?: string | null;
    header: ReactNode;
    sidebar: ReactNode;
    children: ReactNode;
}

export function TokenPageScaffold({
    viewedEvent,
    background,
    displayName,
    breadcrumbCanonicalHref,
    breadcrumbVariantSymbol,
    buyAddress,
    buySymbol,
    buyLogoURI,
    advisory = null,
    advisoryBanner,
    tradeOnChainHref = null,
    tradeOnChainLabel = null,
    header,
    sidebar,
    children,
}: TokenPageScaffoldProps) {
    const hasBottomBar = Boolean(buyAddress) || Boolean(tradeOnChainHref && tradeOnChainLabel);
    return (
        <main className="min-h-dvh bg-gradient-to-b from-white via-white to-white relative overflow-x-hidden">
            {viewedEvent}
            {background}

            <TokenBreadcrumb
                displayName={displayName}
                canonicalHref={breadcrumbCanonicalHref}
                variantSymbol={breadcrumbVariantSymbol}
            />

            <div
                className={cn(
                    'mx-auto max-w-7xl px-6 pt-0 relative z-10',
                    hasBottomBar ? 'pb-20 lg:pb-6' : 'pb-4 md:pb-6',
                )}
            >
                {advisoryBanner}
                {header}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mt-8 lg:items-start">
                    <div className="lg:col-span-8 space-y-16">{children}</div>
                    <div className="lg:col-span-4 lg:self-stretch">{sidebar}</div>
                </div>
            </div>

            <section className="relative z-10 border-t border-gray-1400/10">
                <div className={cn('mx-auto max-w-7xl px-6', hasBottomBar && 'pb-28 lg:pb-0')}>
                    <SiteFooter tone="light" />
                </div>
            </section>

            {!buyAddress && tradeOnChainHref && tradeOnChainLabel && (
                <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 pb-[env(safe-area-inset-bottom)] lg:hidden">
                    <div className="pointer-events-auto mx-auto max-w-7xl px-6 py-4">
                        <TradeOnChainLink
                            href={tradeOnChainHref}
                            displayName={displayName}
                            chainLabel={tradeOnChainLabel}
                        />
                    </div>
                </div>
            )}

            {buyAddress && (
                <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 pb-[env(safe-area-inset-bottom)] lg:hidden">
                    <div className="pointer-events-auto mx-auto max-w-7xl px-6 py-4">
                        <SwapProvidersDropdown
                            buyAddress={buyAddress}
                            buyName={displayName}
                            buySymbol={buySymbol}
                            buyLogoURI={buyLogoURI}
                            advisory={advisory}
                        />
                    </div>
                </div>
            )}
        </main>
    );
}
