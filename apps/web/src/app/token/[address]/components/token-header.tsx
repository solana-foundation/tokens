'use client';

import * as React from 'react';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { Ellipsis, Search, Globe, MessageCircle, Send, MessageSquare, X } from 'lucide-react';
import { IconCircleDashed, IconXLogo } from 'symbols-react';
import { TextMorph } from 'torph/react';

import { Badge } from '@tokens/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@tokens/ui/dropdown-menu';
import { Drawer, DrawerClose, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@tokens/ui/drawer';
import { ChainLogo } from '@/components/chain-logo';
import { AssetAdvisoryBadge } from '@/components/asset-advisory-badge';
import { CopyButton } from '@/components/copy-button';
import { PegStatusPill } from '@/components/peg-status-pill';
import { isTradeBlocked, type AssetAdvisory } from '@/lib/asset-advisory';
import { trackEvent } from '@/lib/posthog-client';
import { getTokenLogoURLForMintWithSecondarySymbol } from '@/lib/logo-overrides';
import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import { getVariantHubById, getVariantHubByMint, type CompactPegHealth, type VariantHub } from '@tokens/asset-registry';
import {
    CHAINS,
    CHAIN_KINDS,
    chainAddressKey,
    chainSupports,
    explorerTokenUrl,
    looksLikeSolanaAddress,
    normalizeAddressForChain,
    type ChainKind,
} from '@tokens/asset-registry/chains';
import { TokenVariantsBadge } from './token-variants-badge';
import { TokenRiskPopover } from './token-risk-popover';
import { formatCompactAddress } from '../lib/format';

interface TokenLinks {
    website?: string;
    twitter?: string;
    discord?: string;
    telegram?: string;
    reddit?: string;
}

interface SelectedVariant {
    chain: ChainKind;
    address: string;
    symbol: string;
}

interface TokenHeaderProps {
    address: string;
    /** Chain `address` lives on; absent/null = Solana. */
    chain?: ChainKind | null;
    symbol: string;
    displayName: string;
    displayLogoURI?: string;
    selectedVariant?: SelectedVariant | null;
    links?: TokenLinks;
    explorerHref?: string;
    explorerAriaLabel?: string;
    riskSummaryUrl?: string;
    riskQueryKey?: readonly unknown[];
    variantGroup?: VariantHub | null;
    /** `<chain>:<address>` of the active variant (highlighted in the variants list). */
    variantCurrentKey?: string;
    /** @deprecated Solana-only; use `variantCurrentKey`. Treated as `solana:<address>`. */
    variantCurrentAddress?: string;
    showChainBadge?: boolean;
    variantLinkMode?: 'token' | 'coingecko';
    variantLinkCoinId?: string;
    showSingletonVariantBadge?: boolean;
    /**
     * Advisory on the viewed mint. `compromised`/`blocked` hide Birdeye (lands
     * on a trading widget) and every profile link (website/socials are a
     * post-exploit phishing vector and come from 300s-cached unvetted data);
     * Explorer and Orb stay because read-only verification is the legitimate
     * action. The risk popover is untouched.
     */
    advisory?: AssetAdvisory | null;
    /**
     * Live peg status of the viewed stablecoin mint (Webacy depeg monitor).
     * Only passed when the header describes a single mint; the canonical view
     * of a multi-variant stablecoin shows per-mint pills in the variants list.
     */
    pegHealth?: CompactPegHealth | null;
}

function TokenLogo({
    mint,
    symbol,
    displayName,
    displayLogoURI,
    preferDisplayLogoURI,
}: Pick<TokenHeaderProps, 'symbol' | 'displayName' | 'displayLogoURI'> & {
    mint?: string;
    preferDisplayLogoURI?: boolean;
}) {
    const [hasError, setHasError] = React.useState(false);
    const resolvedLogoURI = normalizeLogoSrc(
        preferDisplayLogoURI && displayLogoURI
            ? displayLogoURI
            : getTokenLogoURLForMintWithSecondarySymbol(mint, symbol, displayName, displayLogoURI),
    );

    if (!resolvedLogoURI || hasError) {
        return (
            <div className="size-[60px] rounded-full bg-gray-100 flex items-center justify-center ring-1 ring-border-light">
                <span className="text-text-low font-medium text-xl">{symbol.slice(0, 2)}</span>
            </div>
        );
    }

    return (
        <Image
            src={resolvedLogoURI}
            alt={displayName}
            width={55}
            height={55}
            priority
            className="size-[60px] rounded-full ring-3 ring-border-extra-light object-cover"
            onError={() => setHasError(true)}
        />
    );
}

function LinkIconButton({
    href,
    icon,
    'aria-label': ariaLabel,
    linkType,
    trackingProperties,
}: {
    href: string;
    icon: React.ReactNode;
    'aria-label': string;
    linkType?: string;
    trackingProperties?: Record<string, unknown>;
}) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={ariaLabel}
            onClick={
                linkType
                    ? () =>
                          trackEvent('external_link_clicked', {
                              link_type: linkType,
                              link_url: href,
                              ...trackingProperties,
                          })
                    : undefined
            }
            className="size-8 rounded-full flex items-center justify-center text-text-medium hover:bg-gray-50 hover:text-text-high transition-colors"
        >
            {icon}
        </a>
    );
}

const LinkDrawerTrigger = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>(
    ({ className, type, 'aria-label': ariaLabel, ...props }, ref) => {
        return (
            <button
                ref={ref}
                type={type ?? 'button'}
                aria-label={ariaLabel ?? 'Open links'}
                className={[
                    'size-8 rounded-full flex items-center justify-center text-text-medium hover:bg-gray-50 hover:text-text-high transition-colors',
                    className,
                ]
                    .filter(Boolean)
                    .join(' ')}
                {...props}
            >
                <Ellipsis className="h-5 w-5" aria-hidden="true" />
            </button>
        );
    },
);
LinkDrawerTrigger.displayName = 'LinkDrawerTrigger';

function LinkDrawerItem({
    href,
    icon,
    label,
    linkType,
    trackingProperties,
}: {
    href: string;
    icon: React.ReactNode;
    label: string;
    linkType?: string;
    trackingProperties?: Record<string, unknown>;
}) {
    return (
        <DrawerClose asChild>
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={
                    linkType
                        ? () =>
                              trackEvent('external_link_clicked', {
                                  link_type: linkType,
                                  link_url: href,
                                  ...trackingProperties,
                              })
                        : undefined
                }
                className="flex items-center justify-between gap-3 px-4 py-3 text-text-extra-high hover:bg-gray-50 transition-colors"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <div className="size-9 rounded-full bg-gray-50 flex items-center justify-center text-text-medium">
                        {icon}
                    </div>
                    <span className="truncate text-sm font-medium">{label}</span>
                </div>
                <span className="text-xs text-text-extra-low">Open</span>
            </a>
        </DrawerClose>
    );
}

function TokenHeaderLinks({
    address,
    chain,
    links,
    explorerHref,
    explorerAriaLabel,
    orbHref,
    birdeyeHref,
    showChainBadge,
    linkTrackingProperties,
    drawerLinkTrackingProperties,
}: {
    address: string;
    chain: ChainKind;
    links?: TokenLinks;
    explorerHref: string;
    explorerAriaLabel: string;
    orbHref: string | null;
    birdeyeHref: string | null;
    showChainBadge: boolean;
    linkTrackingProperties: Record<string, unknown>;
    drawerLinkTrackingProperties: Record<string, unknown>;
}) {
    return (
        <div className="flex items-center gap-2 shrink-0">
            {/* Desktop: show icon links inline */}
            <div className="hidden sm:flex items-center gap-2">
                {orbHref ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Open explorer links"
                                className="size-8 rounded-full flex items-center justify-center text-text-medium hover:bg-gray-50 hover:text-text-high transition-colors"
                            >
                                <Search className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="rounded-[12px]" align="end">
                            <DropdownMenuItem asChild className="gap-2">
                                <a
                                    href={explorerHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() =>
                                        trackEvent('external_link_clicked', {
                                            link_type: 'explorer',
                                            link_url: explorerHref,
                                            source: 'token_header_menu',
                                            token_address: address,
                                            token_chain: chain,
                                        })
                                    }
                                >
                                    <ChainLogo chain={chain} className="h-4 w-4" />
                                    Explorer
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild className="gap-2">
                                <a
                                    href={orbHref}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() =>
                                        trackEvent('external_link_clicked', {
                                            link_type: 'explorer',
                                            link_url: orbHref,
                                            source: 'token_header_menu',
                                            token_address: address,
                                            token_chain: chain,
                                        })
                                    }
                                >
                                    <IconCircleDashed className="h-4 w-4 fill-current" aria-hidden="true" />
                                    Orb
                                </a>
                            </DropdownMenuItem>
                            {birdeyeHref && (
                                <DropdownMenuItem asChild className="gap-2">
                                    <a
                                        href={birdeyeHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={() =>
                                            trackEvent('external_link_clicked', {
                                                link_type: 'birdeye',
                                                link_url: birdeyeHref,
                                                source: 'token_header_menu',
                                                token_address: address,
                                                token_chain: chain,
                                            })
                                        }
                                    >
                                        <Search className="h-4 w-4" aria-hidden="true" />
                                        Birdeye
                                    </a>
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <LinkIconButton
                        href={explorerHref}
                        icon={<Search className="h-4 w-4" />}
                        aria-label={explorerAriaLabel}
                        linkType="explorer"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
                {links?.website && (
                    <LinkIconButton
                        href={links.website}
                        icon={<Globe className="h-4 w-4" />}
                        aria-label="Website"
                        linkType="website"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
                {links?.twitter && (
                    <LinkIconButton
                        href={links.twitter}
                        icon={<IconXLogo className="h-4 w-4 fill-text-high" />}
                        aria-label="X (Twitter)"
                        linkType="twitter"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
                {links?.discord && (
                    <LinkIconButton
                        href={links.discord}
                        icon={<MessageCircle className="h-4 w-4" />}
                        aria-label="Discord"
                        linkType="discord"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
                {links?.telegram && (
                    <LinkIconButton
                        href={links.telegram}
                        icon={<Send className="h-4 w-4" />}
                        aria-label="Telegram"
                        linkType="telegram"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
                {links?.reddit && (
                    <LinkIconButton
                        href={links.reddit}
                        icon={<MessageSquare className="h-4 w-4" />}
                        aria-label="Reddit"
                        linkType="reddit"
                        trackingProperties={linkTrackingProperties}
                    />
                )}
            </div>

            {/* Mobile: collapse into a drawer */}
            <div className="sm:hidden absolute top-0 right-12">
                <Drawer>
                    <DrawerTrigger asChild>
                        <LinkDrawerTrigger />
                    </DrawerTrigger>
                    <DrawerContent>
                        <DrawerHeader className="px-6 pt-6 pb-4 text-left">
                            <DrawerTitle className="text-title-sm text-text-extra-high">Links</DrawerTitle>
                        </DrawerHeader>

                        <div className="px-6">
                            <div className="overflow-hidden rounded-2xl border border-border-light divide-y divide-border-light">
                                <LinkDrawerItem
                                    href={explorerHref}
                                    label={explorerAriaLabel}
                                    icon={
                                        showChainBadge ? (
                                            <ChainLogo chain={chain} className="h-4 w-4" />
                                        ) : (
                                            <Search className="h-4 w-4" aria-hidden="true" />
                                        )
                                    }
                                    linkType="explorer"
                                    trackingProperties={drawerLinkTrackingProperties}
                                />
                                {orbHref && (
                                    <LinkDrawerItem
                                        href={orbHref}
                                        label="Orb"
                                        icon={<IconCircleDashed className="h-4 w-4 fill-current" aria-hidden="true" />}
                                        linkType="explorer"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {birdeyeHref && (
                                    <LinkDrawerItem
                                        href={birdeyeHref}
                                        label="Birdeye"
                                        icon={<Search className="h-4 w-4" aria-hidden="true" />}
                                        linkType="birdeye"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {links?.website && (
                                    <LinkDrawerItem
                                        href={links.website}
                                        label="Website"
                                        icon={<Globe className="h-4 w-4" aria-hidden="true" />}
                                        linkType="website"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {links?.twitter && (
                                    <LinkDrawerItem
                                        href={links.twitter}
                                        label="X (Twitter)"
                                        icon={<IconXLogo className="h-4 w-4 fill-text-high" aria-hidden="true" />}
                                        linkType="twitter"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {links?.discord && (
                                    <LinkDrawerItem
                                        href={links.discord}
                                        label="Discord"
                                        icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
                                        linkType="discord"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {links?.telegram && (
                                    <LinkDrawerItem
                                        href={links.telegram}
                                        label="Telegram"
                                        icon={<Send className="h-4 w-4" aria-hidden="true" />}
                                        linkType="telegram"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                                {links?.reddit && (
                                    <LinkDrawerItem
                                        href={links.reddit}
                                        label="Reddit"
                                        icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
                                        linkType="reddit"
                                        trackingProperties={drawerLinkTrackingProperties}
                                    />
                                )}
                            </div>
                        </div>
                    </DrawerContent>
                </Drawer>
            </div>
        </div>
    );
}

/**
 * The chain mark on the main logo. Scales up from nothing when a variant is selected and
 * back down to nothing before unmounting when the selection clears (250ms, globals.css);
 * `chain === null` means hidden.
 */
function ChainMarkBadge({ chain }: { chain: ChainKind | null }) {
    // Keep the last chain on screen while the exit animation plays.
    const [shown, setShown] = React.useState<ChainKind | null>(chain);
    if (chain !== null && chain !== shown) setShown(chain);

    const closing = chain === null && shown !== null;

    if (shown === null) return null;

    return (
        <div className="absolute bottom-0 right-0 translate-x-1.5 translate-y-1.5">
            <div
                data-state={closing ? 'closed' : 'open'}
                onAnimationEnd={event => {
                    if (closing && event.animationName === 'token-scale-out') setShown(null);
                }}
                className="token-chain-badge flex size-6 items-center justify-center rounded-lg border-2 border-border-extra-light bg-white"
                title={CHAINS[shown].label}
                aria-label={CHAINS[shown].label}
            >
                <ChainLogo chain={shown} className="h-3.5 w-3.5 text-text-extra-high" />
            </div>
        </div>
    );
}

export function TokenHeader({
    address,
    chain: chainProp,
    symbol,
    displayName,
    displayLogoURI,
    selectedVariant,
    links,
    explorerHref: explorerHrefProp,
    explorerAriaLabel: explorerAriaLabelProp,
    riskSummaryUrl,
    riskQueryKey,
    variantGroup,
    variantCurrentKey,
    variantCurrentAddress,
    showChainBadge: showChainBadgeProp,
    variantLinkMode = 'token',
    variantLinkCoinId,
    showSingletonVariantBadge = false,
    advisory = null,
    pegHealth = null,
}: TokenHeaderProps) {
    const router = useRouter();
    const pathname = usePathname();
    const tradeBlocked = isTradeBlocked(advisory);

    const chain: ChainKind = chainProp ?? 'solana';
    const isSolana = chain === 'solana';
    // `address` is a real on-chain address only when it parses for `chain`;
    // the canonical view may pass an asset id / CoinGecko id here instead.
    const canonicalAddress = normalizeAddressForChain(chain, address) ? address : undefined;
    // Registry + logo overrides are keyed by Solana mint; never feed them an EVM address.
    const logoMint = isSolana ? canonicalAddress : undefined;

    const variantsGroup = variantGroup ?? (logoMint ? getVariantHubByMint(logoMint) : getVariantHubById(address));
    const variantsCount = React.useMemo(() => {
        if (!variantsGroup) return 0;
        return new Set(variantsGroup.addresses.map(item => chainAddressKey(item.chain ?? 'solana', item.address))).size;
    }, [variantsGroup]);
    const hasVariants = variantsCount > 1 || (showSingletonVariantBadge && variantsCount > 0);
    const variantsCurrentKey =
        variantCurrentKey ??
        (variantCurrentAddress ? chainAddressKey('solana', variantCurrentAddress) : chainAddressKey(chain, address));
    const explorerHref = explorerHrefProp ?? explorerTokenUrl(chain, address);
    const explorerAriaLabel = explorerAriaLabelProp ?? `View on ${CHAINS[chain].explorer.name}`;
    // The chain mark on the main logo only appears once a variant is selected
    // (the canonical view is chain-agnostic); it then shows that variant's chain.
    const showChainBadge = showChainBadgeProp ?? Boolean(selectedVariant);
    const orbHref =
        isSolana && looksLikeSolanaAddress(address)
            ? `https://orbmarkets.io/token/${encodeURIComponent(address)}`
            : null;
    const birdeyeHref =
        isSolana && looksLikeSolanaAddress(address)
            ? `https://birdeye.so/solana/token/${encodeURIComponent(address)}?tab=trades&trades_layout=table`
            : null;

    const linkTrackingProperties = {
        source: 'token_header',
        token_address: address,
        token_chain: chain,
        ...(symbol ? { token_symbol: symbol } : {}),
    };
    const drawerLinkTrackingProperties = {
        source: 'token_header_drawer',
        token_address: address,
        token_chain: chain,
        ...(symbol ? { token_symbol: symbol } : {}),
    };

    const trimmedSelectedSymbol = (selectedVariant?.symbol ?? '').trim();
    const shouldShowSelectedVariant = trimmedSelectedSymbol.length > 0 && Boolean(selectedVariant?.address?.trim());
    const shouldShowCanonicalCopyAddress = !hasVariants && !shouldShowSelectedVariant && Boolean(canonicalAddress);
    const badgeSymbol = shouldShowSelectedVariant ? trimmedSelectedSymbol : symbol;

    function clearVariantSelection(): void {
        trackEvent('variant_selection_cleared', {
            token_address: address,
            token_chain: chain,
            ...(selectedVariant ? { variant_mint: selectedVariant.address, variant_chain: selectedVariant.chain } : {}),
        });

        // Avoid `useSearchParams()` to preserve static rendering for this route.
        // This handler only runs on the client.
        const nextParams = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
        for (const chainKind of CHAIN_KINDS) nextParams.delete(chainKind);

        const query = nextParams.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }

    return (
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-0 sm:gap-5 mb-8">
            <div className="flex cols-span-1 items-start flex-col sm:flex-row sm:col-span-8 gap-2 sm:items-end">
                {/* Token Logo with Solana Badge */}
                <div className="relative shrink-0 mr-2">
                    <TokenLogo
                        mint={logoMint}
                        symbol={symbol}
                        displayName={displayName}
                        displayLogoURI={displayLogoURI}
                        preferDisplayLogoURI={shouldShowSelectedVariant}
                    />
                    <ChainMarkBadge chain={showChainBadge ? chain : null} />
                </div>

                {/* Token Info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h1 className="text-title-md text-text-extra-high font-semibold truncate">{displayName}</h1>
                        {chainSupports(chain, 'risk') ? (
                            <TokenRiskPopover
                                address={address}
                                riskSummaryUrl={riskSummaryUrl}
                                riskQueryKey={riskQueryKey}
                            />
                        ) : null}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                            variant="secondary"
                            className="bg-[var(--badge-default-bg)] backdrop-blur-sm hover:cursor-crosshair px-2 py-1 text-[var(--badge-default-text)] font-medium text-xs inline-flex items-center gap-1"
                        >
                            <TextMorph as="span" respectReducedMotion>
                                {`$${badgeSymbol}`}
                            </TextMorph>
                            {shouldShowSelectedVariant ? (
                                <button
                                    type="button"
                                    aria-label="Clear variant selection"
                                    onClick={clearVariantSelection}
                                    className="ml-0.5 inline-flex size-4 items-center justify-center rounded-sm text-text-extra-low hover:text-text-high hover:bg-gray-1400/10 transition-colors cursor-pointer"
                                >
                                    <X className="size-3" aria-hidden="true" />
                                </button>
                            ) : null}
                        </Badge>
                        <AssetAdvisoryBadge advisory={advisory} />
                        <PegStatusPill pegHealth={pegHealth} />
                        {hasVariants && variantsGroup ? (
                            <TokenVariantsBadge
                                group={variantsGroup}
                                currentKey={variantsCurrentKey}
                                linkMode={variantLinkMode}
                                coingeckoCoinId={variantLinkCoinId}
                            />
                        ) : shouldShowCanonicalCopyAddress && canonicalAddress ? (
                            <CopyButton
                                textToCopy={canonicalAddress}
                                ariaLabel="Copy address"
                                trackingEvent="address_copied"
                                trackingProperties={{
                                    token_address: address,
                                    token_chain: chain,
                                    source: 'token_header',
                                }}
                                className="!bg-transparent hover:!bg-[var(--badge-default-bg)] border border-transparent px-2 py-1 rounded-full gap-1 text-[var(--badge-default-text)] font-medium text-xs [&>span]:text-xs [&>span]:leading-4"
                                displayText={
                                    <TextMorph
                                        as="span"
                                        respectReducedMotion
                                        className="font-sans text-xs text-[var(--badge-default-text)] tabular-nums"
                                    >
                                        {formatCompactAddress(canonicalAddress)}
                                    </TextMorph>
                                }
                                iconClassName="text-text-extra-low group-hover:text-text-high"
                                iconClassNameCheck="text-green-700"
                            />
                        ) : null}
                        {shouldShowSelectedVariant ? (
                            <CopyButton
                                textToCopy={selectedVariant?.address ?? ''}
                                ariaLabel="Copy address"
                                trackingEvent="address_copied"
                                trackingProperties={{
                                    token_address: address,
                                    token_chain: chain,
                                    ...(selectedVariant
                                        ? {
                                              variant_mint: selectedVariant.address,
                                              variant_chain: selectedVariant.chain,
                                          }
                                        : {}),
                                    source: 'token_header',
                                }}
                                className="!bg-transparent hover:!bg-[var(--badge-default-bg)] border border-transparent px-2 py-1 rounded-full gap-1 text-[var(--badge-default-text)] font-medium text-xs [&>span]:text-xs [&>span]:leading-4"
                                displayText={
                                    <TextMorph
                                        as="span"
                                        respectReducedMotion
                                        className="font-sans text-xs text-[var(--badge-default-text)] tabular-nums"
                                    >
                                        {formatCompactAddress(selectedVariant?.address)}
                                    </TextMorph>
                                }
                                iconClassName="text-text-extra-low group-hover:text-text-high"
                                iconClassNameCheck="text-green-700"
                            />
                        ) : null}
                    </div>
                </div>

                {/* Links */}
                <TokenHeaderLinks
                    address={address}
                    chain={chain}
                    links={tradeBlocked ? undefined : links}
                    explorerHref={explorerHref}
                    explorerAriaLabel={explorerAriaLabel}
                    orbHref={orbHref}
                    birdeyeHref={tradeBlocked ? null : birdeyeHref}
                    showChainBadge={showChainBadge}
                    linkTrackingProperties={linkTrackingProperties}
                    drawerLinkTrackingProperties={drawerLinkTrackingProperties}
                />
            </div>
            <div className="col-span-4" />
        </div>
    );
}
