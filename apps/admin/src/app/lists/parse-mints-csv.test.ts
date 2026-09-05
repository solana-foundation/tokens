import { describe, expect, it } from 'bun:test';

import { parseMintsCsv } from './parse-mints-csv';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('parseMintsCsv', () => {
    it('reads a headed CSV with mint + note columns in any order', () => {
        const text = ['note,mint', 'stable,' + USDC, '"wrapped, native",' + WSOL].join('\n');
        const parsed = parseMintsCsv(text);
        expect(parsed.headerDetected).toBe(true);
        expect(parsed.rows).toEqual([
            { mint: USDC, note: 'stable', line: 2 },
            { mint: WSOL, note: 'wrapped, native', line: 3 },
        ]);
        expect(parsed.invalid).toEqual([]);
    });

    it('accepts address/memo header synonyms and tab delimiters', () => {
        const text = `Token Address\tMemo\n${USDC}\tusd\n${BONK}\t`;
        const parsed = parseMintsCsv(text);
        expect(parsed.headerDetected).toBe(true);
        expect(parsed.rows).toEqual([
            { mint: USDC, note: 'usd', line: 2 },
            { mint: BONK, note: null, line: 3 },
        ]);
    });

    it('reads a headerless CSV, taking the next cell as the note', () => {
        const parsed = parseMintsCsv(`${USDC},USD Coin\n${WSOL}`);
        expect(parsed.headerDetected).toBe(false);
        expect(parsed.rows).toEqual([
            { mint: USDC, note: 'USD Coin', line: 1 },
            { mint: WSOL, note: null, line: 2 },
        ]);
    });

    it('reads bare lists: one per line, or space/comma separated', () => {
        const parsed = parseMintsCsv(`${USDC}\n\n${WSOL} ${BONK}\n`);
        expect(parsed.rows.map(r => r.mint)).toEqual([USDC, WSOL, BONK]);
    });

    it('drops duplicates (first wins) and reports invalid lines', () => {
        const parsed = parseMintsCsv(`${USDC},first\nnot-a-mint\n${USDC},second\n`);
        expect(parsed.rows).toEqual([{ mint: USDC, note: 'first', line: 1 }]);
        expect(parsed.duplicates).toBe(1);
        expect(parsed.invalid).toEqual([{ line: 2, value: 'not-a-mint' }]);
    });

    it('handles Windows line endings and empty input', () => {
        expect(parseMintsCsv(`mint\r\n${USDC}\r\n`).rows).toEqual([{ mint: USDC, note: null, line: 2 }]);
        expect(parseMintsCsv('')).toEqual({ rows: [], invalid: [], duplicates: 0, headerDetected: false });
    });

    it('treats a header-looking row that is not a known column as invalid, not as a header', () => {
        const parsed = parseMintsCsv(`symbol\n${USDC}`);
        expect(parsed.headerDetected).toBe(false);
        expect(parsed.invalid).toEqual([{ line: 1, value: 'symbol' }]);
        expect(parsed.rows).toEqual([{ mint: USDC, note: null, line: 2 }]);
    });
});
