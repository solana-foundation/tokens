/**
 * Query intent classification.
 *
 * The intent decides how the pipeline behaves before any scoring happens:
 * - `mint`   → this is a lookup, not a search. Never fuzzy-match an address.
 * - `ticker` → user almost certainly wants *the* canonical token; impersonation
 *              risk is highest here, so match + credibility dominate.
 * - `name`   → broader recall; ranking quality matters more than hard precision.
 */

import { normalizeClaim } from './claims';
import type { QueryInterpretation } from './types';

export function looksLikeSolanaMintAddress(value: string): boolean {
    // Base58 (no 0,O,I,l) and common Solana mint length range.
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

const TICKER_PATTERN = /^[$]?[A-Z0-9._-]{1,12}$/;

export function classifyQuery(rawQuery: string): QueryInterpretation {
    const trimmed = rawQuery.trim();

    if (looksLikeSolanaMintAddress(trimmed)) {
        return { intent: 'mint', normalizedQuery: trimmed, hadSuspiciousCharacters: false };
    }

    const { normalized, hadSuspiciousCharacters } = normalizeClaim(trimmed);
    const tickerish = !normalized.includes(' ') && TICKER_PATTERN.test(normalized);

    return {
        intent: tickerish ? 'ticker' : 'name',
        normalizedQuery: normalized.replace(/^\$/, ''),
        hadSuspiciousCharacters,
    };
}
