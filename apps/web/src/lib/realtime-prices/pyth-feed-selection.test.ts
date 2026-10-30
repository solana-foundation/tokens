import { describe, expect, test } from 'bun:test';

import {
    buildPythSymbolCandidates,
    isSupportedPythTicker,
    pythNamespacesFor,
    selectPythFeed,
    type PythSymbolEntry,
} from './pyth-feed-selection';

const entry = (pyth_lazer_id: number, symbol: string, extra: Partial<PythSymbolEntry> = {}): PythSymbolEntry => ({
    pyth_lazer_id,
    symbol,
    description: symbol.endsWith('X/USD')
        ? 'XSTOCK / US DOLLAR'
        : symbol.endsWith('ON/USD')
          ? 'ONDO TOKENIZED STOCK / US DOLLAR'
          : '',
    state: 'stable',
    asset_type: symbol.startsWith('Crypto.') ? 'crypto' : 'equity',
    min_channel: 'fixed_rate@200ms',
    hermes_id: `hermes-${pyth_lazer_id}`,
    ...extra,
});

// Shapes copied from GET https://pyth.dourolabs.app/v1/symbols?query=TSLA on 2026-10-30.
const TSLA_SEARCH: PythSymbolEntry[] = [
    entry(1435, 'Equity.US.TSLA/USD'),
    entry(1746, 'Equity.US.TSLA/USD.EXT', { state: 'inactive' }),
    entry(1846, 'Crypto.TSLAX/TSLA.RR', { asset_type: 'crypto-redemption-rate' }),
    entry(1847, 'Crypto.TSLAX/USD'),
    entry(3128, 'Crypto.TSLAON/USD'),
    entry(3185, 'Equity.Index.TSLA/USD'),
];

describe('pythNamespacesFor', () => {
    test('variants always resolve to the token itself', () => {
        expect(pythNamespacesFor('equity', 'variant')).toEqual(['Crypto']);
        expect(pythNamespacesFor(undefined, 'variant')).toEqual(['Crypto']);
    });

    test('canonical categories map to their market namespaces', () => {
        expect(pythNamespacesFor('equity', 'canonical')).toEqual(['Equity.US', 'Equity.Index']);
        expect(pythNamespacesFor('etf', 'canonical')).toEqual(['Equity.US']);
        expect(pythNamespacesFor('commodity', 'canonical')[0]).toBe('Metal');
        expect(pythNamespacesFor('lst', 'canonical')).toEqual(['Crypto']);
        expect(pythNamespacesFor('something-new', 'canonical')).toEqual(['Crypto']);
    });
});

describe('buildPythSymbolCandidates', () => {
    test('normalizes the ticker and builds exact Pyth symbols', () => {
        expect(buildPythSymbolCandidates(' tsla ', 'equity', 'canonical')).toEqual([
            'Equity.US.TSLA/USD',
            'Equity.Index.TSLA/USD',
        ]);
        expect(buildPythSymbolCandidates('TSLAx', 'equity', 'variant')).toEqual(['Crypto.TSLAX/USD']);
    });

    test('rejects tickers Pyth cannot have', () => {
        expect(buildPythSymbolCandidates('', 'crypto', 'canonical')).toEqual([]);
        expect(buildPythSymbolCandidates('a b', 'crypto', 'canonical')).toEqual([]);
        expect(isSupportedPythTicker('BRK.B')).toBe(true);
        expect(isSupportedPythTicker('SOL/USD')).toBe(false);
    });
});

describe('selectPythFeed', () => {
    test('canonical equity picks the US listing over the 24/7 index and the tokenized feeds', () => {
        expect(selectPythFeed({ ticker: 'TSLA', category: 'equity', mode: 'canonical' }, TSLA_SEARCH)).toMatchObject({
            feedId: 1435,
            symbol: 'Equity.US.TSLA/USD',
            hermesId: 'hermes-1435',
        });
    });

    test('falls back to the next namespace when the first is missing', () => {
        const indexOnly = TSLA_SEARCH.filter(e => e.pyth_lazer_id !== 1435);
        expect(selectPythFeed({ ticker: 'TSLA', category: 'equity', mode: 'canonical' }, indexOnly)?.feedId).toBe(3185);
    });

    test('variant tickers resolve to the xStock / Ondo token feeds', () => {
        expect(selectPythFeed({ ticker: 'TSLAx', category: 'equity', mode: 'variant' }, TSLA_SEARCH)?.feedId).toBe(
            1847,
        );
        expect(selectPythFeed({ ticker: 'TSLAon', category: 'equity', mode: 'variant' }, TSLA_SEARCH)?.feedId).toBe(
            3128,
        );
    });

    test('equity variants reject crypto feeds that merely share the ticker', () => {
        // AT&T's Ondo token is `TON`; Pyth's Crypto.TON/USD is Toncoin.
        const toncoin = [entry(1234, 'Crypto.TON/USD', { description: 'TONCOIN / US DOLLAR' })];
        expect(selectPythFeed({ ticker: 'TON', category: 'equity', mode: 'variant' }, toncoin)).toBeNull();
        // Li Auto's Ondo token is `LION`; Pyth's Crypto.LION/USD is a different asset.
        const lion = [entry(1235, 'Crypto.LION/USD', { description: 'LION / US DOLLAR' })];
        expect(selectPythFeed({ ticker: 'LION', category: 'equity', mode: 'variant' }, lion)).toBeNull();
        // Crypto-category variants keep plain crypto feeds (JitoSOL, PAXG...).
        const paxg = [entry(1236, 'Crypto.PAXG/USD', { description: 'PAX GOLD / US DOLLAR' })];
        expect(selectPythFeed({ ticker: 'PAXG', category: 'commodity', mode: 'variant' }, paxg)?.feedId).toBe(1236);
        expect(selectPythFeed({ ticker: 'TON', category: 'crypto', mode: 'variant' }, toncoin)?.feedId).toBe(1234);
    });

    test('a bare variant ticker never leaks into the underlying equity feed', () => {
        expect(selectPythFeed({ ticker: 'TSLA', category: 'equity', mode: 'variant' }, TSLA_SEARCH)).toBeNull();
    });

    test('ignores inactive, coming_soon and malformed entries', () => {
        const entries: PythSymbolEntry[] = [
            entry(1, 'Crypto.SOL/USD', { state: 'coming_soon' }),
            entry(2, 'Crypto.SOL/USD', { state: 'inactive' }),
            { pyth_lazer_id: Number.NaN, symbol: 'Crypto.SOL/USD', state: 'stable' },
        ];
        expect(selectPythFeed({ ticker: 'SOL', category: 'crypto', mode: 'canonical' }, entries)).toBeNull();
        expect(
            selectPythFeed({ ticker: 'SOL', category: 'crypto', mode: 'canonical' }, [
                ...entries,
                entry(6, 'Crypto.SOL/USD'),
            ])?.feedId,
        ).toBe(6);
    });

    test('commodities prefer spot metal, then the ETF listing', () => {
        const gold = [entry(346, 'Metal.XAU/USD', { asset_type: 'metal' }), entry(1157, 'Equity.US.GLD/USD')];
        expect(selectPythFeed({ ticker: 'XAU', category: 'commodity', mode: 'canonical' }, gold)?.feedId).toBe(346);
        expect(selectPythFeed({ ticker: 'GLD', category: 'commodity', mode: 'canonical' }, gold)?.feedId).toBe(1157);
    });
});
