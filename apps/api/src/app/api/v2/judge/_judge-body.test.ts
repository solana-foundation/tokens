import { describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { parseJudgeBody, rawFromJudgeCandidate, MAX_JUDGE_CANDIDATES } = await import('./_judge-body');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

async function failure(json: unknown) {
    const error = (await Effect.runPromise(Effect.flip(parseJudgeBody(json)))) as {
        _tag: string;
        message: string;
        details?: Record<string, unknown>;
    };
    expect(error._tag).toBe('BadRequestError');
    return error;
}

describe('parseJudgeBody', () => {
    it('rejects non-objects, missing, empty and oversized candidate lists with details.code', async () => {
        expect((await failure(null)).details).toEqual({ code: 'invalid_body' });
        expect((await failure([])).details).toEqual({ code: 'invalid_body' });
        expect((await failure({})).details).toEqual({ code: 'invalid_candidates' });
        expect((await failure({ candidates: 'x' })).details).toEqual({ code: 'invalid_candidates' });
        expect((await failure({ candidates: [] })).details).toEqual({ code: 'invalid_candidates' });
        const tooMany = await failure({
            candidates: Array.from({ length: MAX_JUDGE_CANDIDATES + 1 }, () => ({ mint: USDC })),
        });
        expect(tooMany.details).toEqual({
            code: 'too_many_candidates',
            max: MAX_JUDGE_CANDIDATES,
            received: MAX_JUDGE_CANDIDATES + 1,
        });
    });

    it('rejects a bad mint or a non-numeric market field', async () => {
        expect((await failure({ candidates: [{ mint: 'nope' }] })).message).toContain('Invalid candidates');
        expect((await failure({ candidates: [{ mint: USDC, price: '1' }] })).message).toContain('Invalid candidates');
        expect((await failure({ candidates: [{}] })).message).toContain('Invalid candidates');
    });

    it('keeps the first occurrence of a duplicate mint, in the caller order', async () => {
        const { raws } = await Effect.runPromise(
            parseJudgeBody({
                candidates: [{ mint: BONK, symbol: 'first' }, { mint: USDC }, { mint: BONK, symbol: 'second' }],
            }),
        );
        expect(raws.map(r => r.mint)).toEqual([BONK, USDC]);
        expect(raws[0]?.symbol).toBe('first');
    });

    it('returns the body so the shared flag parser can read q / policy / overrides from it', async () => {
        const { body } = await Effect.runPromise(
            parseJudgeBody({ q: 'x', policy: 'degen', candidates: [{ mint: USDC }] }),
        );
        expect(body.q).toBe('x');
        expect(body.policy).toBe('degen');
    });
});

describe('rawFromJudgeCandidate', () => {
    it('marks the source as caller and normalizes blanks, NaN and createdAt', () => {
        const raw = rawFromJudgeCandidate({
            mint: USDC,
            symbol: '  ',
            name: 'USD Coin ',
            decimals: 6,
            price: Number.NaN,
            liquidityUsd: 1_000_000,
            createdAt: 1_700_000_000,
        });
        expect(raw.sources).toEqual(['caller']);
        expect(raw.symbol).toBeNull();
        expect(raw.name).toBe('USD Coin');
        expect(raw.decimals).toBe(6);
        expect(raw.price).toBeNull();
        expect(raw.liquidityUsd).toBe(1_000_000);
        expect(raw.tokenMintTime).toBe(new Date(1_700_000_000 * 1000).toISOString());
    });

    it('accepts ISO and epoch-ms createdAt, treats garbage as unknown', () => {
        expect(rawFromJudgeCandidate({ mint: USDC, createdAt: '2024-01-02T03:04:05Z' }).tokenMintTime).toBe(
            '2024-01-02T03:04:05.000Z',
        );
        expect(rawFromJudgeCandidate({ mint: USDC, createdAt: 1_700_000_000_000 }).tokenMintTime).toBe(
            new Date(1_700_000_000_000).toISOString(),
        );
        expect(rawFromJudgeCandidate({ mint: USDC, createdAt: 'yesterday' }).tokenMintTime).toBeNull();
        expect(rawFromJudgeCandidate({ mint: USDC }).tokenMintTime).toBeNull();
    });
});
