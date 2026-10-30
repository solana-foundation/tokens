'use client';

import * as React from 'react';

import type { ChainKind } from '@tokens/asset-registry/chains';

import { trackEvent } from '@/lib/posthog-client';

interface TokenViewedEventProps {
    tokenAddress: string;
    tokenAddressType?: ChainKind | 'coingecko';
    /** Chain of the viewed variant (null on a canonical view without an active variant). */
    tokenChain?: ChainKind | null;
    tokenSymbol: string;
    tokenName: string;
    tokenPrice?: number | null;
    tokenPriceChange24h?: number | null;
    tokenMarketCap?: number | null;
    hasCoingeckoId?: boolean;
    coingeckoId?: string;
    source?: string;
    /** Active advisory status on the viewed mint, when any. */
    advisoryStatus?: string | null;
}

// Client-side analytics event so we capture a real distinct_id/session.
export function TokenViewedEvent({
    tokenAddress,
    tokenAddressType,
    tokenChain,
    tokenSymbol,
    tokenName,
    tokenPrice,
    tokenPriceChange24h,
    tokenMarketCap,
    hasCoingeckoId,
    coingeckoId,
    source,
    advisoryStatus,
}: TokenViewedEventProps) {
    React.useEffect(() => {
        trackEvent('token_viewed', {
            token_address: tokenAddress,
            ...(tokenAddressType ? { token_address_type: tokenAddressType } : {}),
            ...(tokenChain ? { token_chain: tokenChain } : {}),
            token_symbol: tokenSymbol,
            token_name: tokenName,
            token_price: tokenPrice ?? undefined,
            token_price_change_24h: tokenPriceChange24h ?? undefined,
            token_market_cap: tokenMarketCap ?? undefined,
            ...(typeof hasCoingeckoId === 'boolean' ? { has_coingecko_id: hasCoingeckoId } : {}),
            ...(coingeckoId ? { coingecko_id: coingeckoId } : {}),
            ...(source ? { source } : {}),
            ...(advisoryStatus ? { advisory_status: advisoryStatus } : {}),
        });
    }, [
        advisoryStatus,
        coingeckoId,
        hasCoingeckoId,
        source,
        tokenAddress,
        tokenAddressType,
        tokenChain,
        tokenMarketCap,
        tokenName,
        tokenPrice,
        tokenPriceChange24h,
        tokenSymbol,
    ]);

    return null;
}
