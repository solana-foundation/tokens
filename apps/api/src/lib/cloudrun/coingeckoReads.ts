import type {
    CoingeckoCoinResult,
    CoingeckoCoinSearchResult,
    CoingeckoOhlcvRow,
    CoingeckoPriceSnapshot,
    CoingeckoPriceBatchEntry,
    CoingeckoTickersResult,
} from '../../../../cloudrun-assets/src/handlers/coingeckoReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type GetCoinByIdArgs = { id: string };
export type GetCoinByIdResult = CoingeckoCoinResult | null;

export function getCoinById(args: GetCoinByIdArgs): Effect.Effect<GetCoinByIdResult, CloudRunError> {
    return cloudRunQuery<GetCoinByIdResult>('assets', 'coingeckoReadsGetCoinById', { ...args });
}

export type GetCoinBySolanaMintArgs = { mint: string };
export type GetCoinBySolanaMintResult = CoingeckoCoinResult | null;

export function getCoinBySolanaMint(
    args: GetCoinBySolanaMintArgs,
): Effect.Effect<GetCoinBySolanaMintResult, CloudRunError> {
    return cloudRunQuery<GetCoinBySolanaMintResult>('assets', 'coingeckoReadsGetCoinBySolanaMint', { ...args });
}

export type SearchCoinsArgs = { query: string; limit?: number };
export type SearchCoinsResult = CoingeckoCoinSearchResult[];

export function searchCoins(args: SearchCoinsArgs): Effect.Effect<SearchCoinsResult, CloudRunError> {
    return cloudRunQuery<SearchCoinsResult>('assets', 'coingeckoReadsSearchCoins', { ...args });
}

export type OhlcvInterval = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';
export type ListOhlcvArgs = {
    coinId: string;
    interval: OhlcvInterval;
    from?: number;
    to?: number;
    limit?: number;
};
export type ListOhlcvResult = CoingeckoOhlcvRow[];

export function listOhlcv(args: ListOhlcvArgs): Effect.Effect<ListOhlcvResult, CloudRunError> {
    return cloudRunQuery<ListOhlcvResult>('assets', 'coingeckoReadsListOhlcv', { ...args });
}

export type GetPriceLatestByCoinIdArgs = { coinId: string };
export type GetPriceLatestByCoinIdResult = CoingeckoPriceSnapshot | null;

export function getPriceLatestByCoinId(
    args: GetPriceLatestByCoinIdArgs,
): Effect.Effect<GetPriceLatestByCoinIdResult, CloudRunError> {
    return cloudRunQuery<GetPriceLatestByCoinIdResult>(
        'assets',
        'coingeckoReadsGetPriceLatestByCoinId',
        { ...args },
    );
}

export type GetPriceLatestByCoinIdsArgs = { coinIds: string[] };
export type GetPriceLatestByCoinIdsResult = CoingeckoPriceBatchEntry[];

export function getPriceLatestByCoinIds(
    args: GetPriceLatestByCoinIdsArgs,
): Effect.Effect<GetPriceLatestByCoinIdsResult, CloudRunError> {
    return cloudRunQuery<GetPriceLatestByCoinIdsResult>(
        'assets',
        'coingeckoReadsGetPriceLatestByCoinIds',
        { ...args },
    );
}

export type GetTickersLatestByCoinIdArgs = { coinId: string };
export type GetTickersLatestByCoinIdResult = CoingeckoTickersResult | null;

export function getTickersLatestByCoinId(
    args: GetTickersLatestByCoinIdArgs,
): Effect.Effect<GetTickersLatestByCoinIdResult, CloudRunError> {
    return cloudRunQuery<GetTickersLatestByCoinIdResult>(
        'assets',
        'coingeckoReadsGetTickersLatestByCoinId',
        { ...args },
    );
}
