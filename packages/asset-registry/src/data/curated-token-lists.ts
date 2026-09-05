/**
 * @deprecated Curated list MEMBERSHIP authority is the database
 * (`asset_collections` / `asset_collection_members`), edited via the admin
 * app. This module is a compatibility shim for consumers that have not yet
 * migrated to DB-backed reads; it is deleted in the final cutover step.
 *
 * - Slug ids/order/aliases: `../curated-lists` (permanent home).
 * - Mint arrays (canonical-asset generation inputs): `./list-mints` (permanent home).
 */
import { CURATED_LIST_SLUGS, type CuratedListSlug, normalizeCuratedListSlug } from '../curated-lists';
import {
    CURRENCY_MINTS,
    ETF_MINTS,
    LST_MINTS,
    MAJORS_MINTS,
    METALS_MINTS,
    RWA_MINTS,
    STOCKS_MINTS,
} from './list-mints';

export interface CuratedTokenList {
    id: string;
    name: string;
    description: string;
    addresses: string[];
}

export type CuratedTokenListId = CuratedListSlug;

export const CURATED_TOKEN_LISTS: Record<CuratedTokenListId, CuratedTokenList> = {
    majors: {
        id: 'majors',
        name: 'Crypto',
        description: 'Major crypto assets on Solana.',
        addresses: [...MAJORS_MINTS],
    },
    lsts: {
        id: 'lsts',
        name: 'Staking',
        description: 'Liquid staking tokens on Solana.',
        addresses: [...LST_MINTS],
    },
    currencies: {
        id: 'currencies',
        name: 'Currencies',
        description: 'Curated currencies (stablecoins) on Solana.',
        addresses: [...CURRENCY_MINTS],
    },
    rwas: {
        id: 'rwas',
        name: 'Treasuries',
        description: 'Treasuries, funds, and other real world assets on Solana.',
        addresses: [...RWA_MINTS],
    },
    etfs: {
        id: 'etfs',
        name: 'ETFs',
        description: 'Tokenized ETFs and indexes on Solana.',
        addresses: [...ETF_MINTS],
    },
    // Key order preserved from the original file (stocks before metals):
    // judgment consumers iterate Object.keys for per-mint slug precedence.
    stocks: {
        id: 'stocks',
        name: 'Stocks',
        description: 'Tokenized stocks on Solana.',
        addresses: [...STOCKS_MINTS],
    },
    metals: {
        id: 'metals',
        name: 'Metals',
        description: 'Precious metals on Solana.',
        addresses: [...METALS_MINTS],
    },
};

// Order determines tab order in UI
export const CURATED_LIST_ORDER: CuratedTokenListId[] = [...CURATED_LIST_SLUGS];

export function isCuratedTokenListId(value: string): value is CuratedTokenListId {
    return (CURATED_LIST_ORDER as readonly string[]).includes(value);
}

export function normalizeCuratedTokenListId(raw: string): CuratedTokenListId | null {
    return normalizeCuratedListSlug(raw);
}

export function getCuratedTokenList(listId: CuratedTokenListId): CuratedTokenList {
    return CURATED_TOKEN_LISTS[listId];
}

export function getCuratedTokenAddresses(list: CuratedTokenList): string[] {
    return list.addresses;
}
