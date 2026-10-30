import type { PegHealth, StructuralHealth } from '@tokens/asset-registry';

import type { OHLCVData, TokenMarket } from '@/lib/birdeye';
import type { GlobalTokenStats } from '@/lib/coingecko';
import type { computeMarketScore, MarketScoreInput } from '@/lib/token-risk-helpers';
import type { WebacyTokenResponse, WebacyTradingLiteResponse } from '@/lib/webacy';

export type AssetInclude = 'profile' | 'risk' | 'ohlcv' | 'markets';

export const VALID_INCLUDES: ReadonlyArray<AssetInclude> = ['profile', 'risk', 'ohlcv', 'markets'];

export const INCLUDE_SCOPE: Record<AssetInclude, string> = {
    profile: 'assets:profile:read',
    risk: 'assets:risk:read',
    ohlcv: 'assets:ohlcv:read',
    markets: 'assets:markets:read',
};

export const ASSETS_READ_SCOPE = 'assets:read' as const;

export interface AssetIncludeOk<T> {
    ok: true;
    data: T;
}

export interface AssetIncludeError {
    ok: false;
    reason: 'not_available' | 'not_configured' | 'not_found' | 'error';
    message: string;
}

export type AssetIncludeResult<T> = AssetIncludeOk<T> | AssetIncludeError;

/** Mirrors the `ok: true` arm of `/risk-details` so `include=risk` and the dedicated route agree. */
export interface AssetRiskInclude {
    tokenData: WebacyTokenResponse | null;
    tradingData: WebacyTradingLiteResponse | null;
    marketScoreInput: MarketScoreInput;
    marketScore: ReturnType<typeof computeMarketScore>;
    /** Webacy depeg-monitor status for the selected mint; `null` when unmonitored. */
    pegHealth: PegHealth | null;
    /** Webacy structural-health grade for the selected mint; `null` when unmonitored. */
    structuralHealth: StructuralHealth | null;
}

export interface AssetMarketsInclude {
    markets: TokenMarket[];
    total: number | undefined;
    offset: number;
    limit: number;
}

export type AssetProfileInclude = GlobalTokenStats;
export type AssetOhlcvInclude = OHLCVData[];
