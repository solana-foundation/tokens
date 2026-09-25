import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import {
    findXTokenTags,
    resolveXCashtagSymbols,
    restoreXCashtags,
    restoreXCashtagsInTexts,
    shortenTokenAddress,
} from './x-cashtags';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const UNKNOWN_MINT = 'ArtxrPwHxiyz5x6c7NEdCe5Fo6cD3P5AvnCxHqCWPGWy';
const EVM_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const ORIGINAL_ERROR = console.error;

beforeEach(() => {
    console.error = () => undefined;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.error = ORIGINAL_ERROR;
    if (ORIGINAL_BIRDEYE_KEY === undefined) delete process.env.BIRDEYE_API_KEY;
    else process.env.BIRDEYE_API_KEY = ORIGINAL_BIRDEYE_KEY;
});

describe('findXTokenTags', () => {
    it('finds chain:address token tags in post text', () => {
        expect(findXTokenTags(`BREAKING: solana:${SOL_MINT} broke above $120, up 6% on the day.`)).toEqual([
            { raw: `solana:${SOL_MINT}`, chain: 'solana', address: SOL_MINT },
        ]);
    });

    it('finds tags at the start, end, and next to punctuation', () => {
        const text = `solana:${SOL_MINT}, then (solana:${BONK_MINT}) and finally ethereum:${EVM_ADDRESS}`;
        expect(findXTokenTags(text).map(tag => tag.address)).toEqual([SOL_MINT, BONK_MINT, EVM_ADDRESS]);
    });

    it('ignores prices, urls, plain cashtags, and short address-like words', () => {
        const text = [
            'up 6% to $120 and $SOL',
            'https://t.co/j4q2IvAHGb',
            `https://example.com/solana:${SOL_MINT}`,
            'time: 10:30',
            `@solana:${SOL_MINT}`,
        ].join(' ');
        expect(findXTokenTags(text)).toEqual([]);
    });
});

describe('restoreXCashtags', () => {
    it('replaces resolved tags with $SYMBOL', () => {
        const text = `BREAKING: solana:${SOL_MINT} broke above $120.`;
        expect(restoreXCashtags(text, new Map([[SOL_MINT, 'SOL']]))).toBe('BREAKING: $SOL broke above $120.');
    });

    it('falls back to a shortened address for unresolved tags', () => {
        const text = `Watch solana:${UNKNOWN_MINT} today`;
        expect(restoreXCashtags(text, new Map())).toBe(`Watch $${shortenTokenAddress(UNKNOWN_MINT)} today`);
        expect(shortenTokenAddress(UNKNOWN_MINT)).toBe('Artx…PGWy');
    });
});

describe('resolveXCashtagSymbols', () => {
    it('resolves registry mints without touching the network', async () => {
        globalThis.fetch = (async () => {
            throw new Error('unexpected fetch');
        }) as typeof fetch;

        const symbols = await Effect.runPromise(
            resolveXCashtagSymbols([{ raw: `solana:${SOL_MINT}`, chain: 'solana', address: SOL_MINT }]),
        );
        expect(symbols.get(SOL_MINT)).toBe('SOL');
    });

    it('falls back to Birdeye for mints the registry does not know', async () => {
        process.env.BIRDEYE_API_KEY = 'birdeye-key';
        const requestedMints: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = new URL(String(input));
            expect(url.pathname).toBe('/defi/v3/token/meta-data/multiple');
            requestedMints.push(...(url.searchParams.get('list_address') ?? '').split(','));
            return new Response(
                JSON.stringify({
                    success: true,
                    data: {
                        [BONK_MINT]: { address: BONK_MINT, symbol: 'Bonk', name: 'Bonk', decimals: 5 },
                        [UNKNOWN_MINT]: null,
                    },
                }),
                { status: 200 },
            );
        }) as typeof fetch;

        const symbols = await Effect.runPromise(
            resolveXCashtagSymbols([
                { raw: `solana:${SOL_MINT}`, chain: 'solana', address: SOL_MINT },
                { raw: `solana:${BONK_MINT}`, chain: 'solana', address: BONK_MINT },
                { raw: `solana:${UNKNOWN_MINT}`, chain: 'solana', address: UNKNOWN_MINT },
                { raw: `ethereum:${EVM_ADDRESS}`, chain: 'ethereum', address: EVM_ADDRESS },
            ]),
        );

        expect(requestedMints.sort()).toEqual([BONK_MINT, UNKNOWN_MINT].sort());
        expect(symbols.get(SOL_MINT)).toBe('SOL');
        expect(symbols.get(BONK_MINT)).toBe('Bonk');
        expect(symbols.has(UNKNOWN_MINT)).toBe(false);
        expect(symbols.has(EVM_ADDRESS)).toBe(false);
    });

    it('still resolves registry mints when Birdeye is unavailable', async () => {
        delete process.env.BIRDEYE_API_KEY;
        globalThis.fetch = (async () => {
            throw new Error('unexpected fetch');
        }) as typeof fetch;

        const symbols = await Effect.runPromise(
            resolveXCashtagSymbols([
                { raw: `solana:${SOL_MINT}`, chain: 'solana', address: SOL_MINT },
                { raw: `solana:${BONK_MINT}`, chain: 'solana', address: BONK_MINT },
            ]),
        );
        expect(symbols.get(SOL_MINT)).toBe('SOL');
        expect(symbols.has(BONK_MINT)).toBe(false);
    });
});

describe('restoreXCashtagsInTexts', () => {
    it('leaves texts without tags untouched and skips resolution', async () => {
        globalThis.fetch = (async () => {
            throw new Error('unexpected fetch');
        }) as typeof fetch;
        const texts = ['HUGE: @Solana now hosts more than 3,000 tokenized real-world assets.', 'Up 6% to $120'];
        expect(await Effect.runPromise(restoreXCashtagsInTexts(texts))).toEqual(texts);
    });

    it('restores cashtags across a batch with one resolution pass', async () => {
        delete process.env.BIRDEYE_API_KEY;
        const texts = [
            `BREAKING: solana:${SOL_MINT} broke above $120.`,
            `Also solana:${SOL_MINT} and solana:${UNKNOWN_MINT}.`,
        ];
        expect(await Effect.runPromise(restoreXCashtagsInTexts(texts))).toEqual([
            'BREAKING: $SOL broke above $120.',
            'Also $SOL and $Artx…PGWy.',
        ]);
    });
});
