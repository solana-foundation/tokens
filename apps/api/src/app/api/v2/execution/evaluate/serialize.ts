/**
 * Serialization from the cloudrun quote-fanout result to the public
 * `ExecutionQuoteRow` shape.
 *
 * Extracted from the evaluate route unchanged so the cross-variant route can
 * emit per-variant rows with exactly the same guarantees the single-mint
 * endpoint documents (one `isBest` per available row, gapless ranks,
 * best-first ordering, non-null `best` iff available). One serializer means
 * those guarantees cannot drift between the two surfaces.
 */

import type { ExecutionQuotesLiveResult } from '../../../../../../../cloudrun-assets/src/handlers/liveQuotes';

import {
    computeEdge,
    formatRawAmount,
    rankQuotes,
    type PriceImpactSource,
    type QuoteProvider,
    type SummarizableEntry,
} from './comparison';
import type { ExecutionBestQuote, ExecutionProviderQuote, ExecutionQuoteRow } from './contract';

export interface QuoteTokenRef {
    mint: string;
    symbol: string;
    decimals: number;
}

type LiveEntry = ExecutionQuotesLiveResult['entries'][number];
type LiveCandidate = LiveEntry['candidates'][number];

/**
 * One provider's answer. `rank` and `isBest` make the relationship to the
 * hoisted `best` explicit, so callers (and the contract test) never have to
 * infer it from array position.
 */
function serializeQuote(
    candidate: LiveCandidate,
    rank: number | null,
    isBest: boolean,
    inputToken: QuoteTokenRef,
    outputToken: QuoteTokenRef,
): ExecutionProviderQuote {
    if (candidate.status === 'unavailable') {
        return {
            provider: candidate.provider,
            status: candidate.status,
            reason: candidate.reason,
            rank: null,
            isBest: false,
            input: null,
            output: null,
            effectivePrice: null,
            priceImpactPct: null,
            priceImpactSource: 'unavailable' as PriceImpactSource,
            route: candidate.route,
            contextSlot: null,
            router: null,
            mode: null,
            fees: null,
            quotedAt: candidate.quotedAt,
        };
    }
    const inAmount = formatRawAmount(candidate.inAmountRaw, inputToken.decimals);
    const outAmount = formatRawAmount(candidate.outAmountRaw, outputToken.decimals);
    const inNumeric = Number(inAmount);
    return {
        provider: candidate.provider,
        status: candidate.status,
        rank,
        isBest,
        input: { ...inputToken, amount: inAmount, rawAmount: candidate.inAmountRaw },
        output: { ...outputToken, amount: outAmount, rawAmount: candidate.outAmountRaw },
        // Output per unit of input: the comparable unit price.
        effectivePrice: Number.isFinite(inNumeric) && inNumeric > 0 ? String(Number(outAmount) / inNumeric) : null,
        priceImpactPct: candidate.priceImpactPct,
        // Distinguishes "provider reported zero" from "provider reports
        // nothing" — Titan has no impact field at all.
        priceImpactSource: (candidate.priceImpactPct === null ? 'unavailable' : 'provider') as PriceImpactSource,
        route: candidate.route,
        contextSlot: candidate.contextSlot,
        router: candidate.router,
        mode: candidate.mode,
        fees: candidate.fees,
        quotedAt: candidate.quotedAt,
    };
}

/**
 * Turn the fanout's entries into public rows plus the comparison-summary
 * inputs. Pure; both execution endpoints call this.
 */
export function serializeQuoteRows(args: {
    entries: readonly LiveEntry[];
    side: 'buy' | 'sell';
    inputToken: QuoteTokenRef;
    outputToken: QuoteTokenRef;
}): { quotes: ExecutionQuoteRow[]; summarizable: SummarizableEntry[] } {
    const { entries, side, inputToken, outputToken } = args;
    const summarizable: SummarizableEntry[] = [];
    const quotes: ExecutionQuoteRow[] = entries.map((entry): ExecutionQuoteRow => {
        const availableCandidates = entry.candidates.filter(
            (candidate): candidate is Extract<typeof candidate, { status: 'available' }> =>
                candidate.status === 'available',
        );
        const ranked = rankQuotes(
            availableCandidates.map(candidate => ({
                provider: candidate.provider as QuoteProvider,
                outAmountRaw: candidate.outAmountRaw,
            })),
        );
        const rankByProvider = new Map(ranked.map((quote, index) => [quote.provider, index + 1]));
        const winner = ranked[0]?.provider ?? null;

        const edge = computeEdge({
            ranked,
            outputDecimals: outputToken.decimals,
            side,
            requestRawAmount: entry.request.rawAmount,
        });

        // Ranked best-first, so providerQuotes[1] is the runner-up;
        // unavailable providers trail with rank null.
        const providerQuotes = [...entry.candidates]
            .sort((a, b) => {
                const left = rankByProvider.get(a.provider as QuoteProvider) ?? Number.MAX_SAFE_INTEGER;
                const right = rankByProvider.get(b.provider as QuoteProvider) ?? Number.MAX_SAFE_INTEGER;
                return left - right;
            })
            .map(candidate =>
                serializeQuote(
                    candidate,
                    rankByProvider.get(candidate.provider as QuoteProvider) ?? null,
                    candidate.status === 'available' && candidate.provider === winner,
                    inputToken,
                    outputToken,
                ),
            );

        summarizable.push({
            request: { unit: entry.request.unit, amount: entry.request.amount },
            availableProviders: availableCandidates.map(candidate => candidate.provider as QuoteProvider),
            unavailableProviders: entry.candidates
                .filter(candidate => candidate.status === 'unavailable')
                .map(candidate => candidate.provider as QuoteProvider),
            winner,
            edgeBps: edge?.bps ?? null,
        });

        const best = providerQuotes.find((quote): quote is ExecutionBestQuote => quote.isBest) ?? null;
        // No winner means nothing quoted, whatever the upstream entry claimed —
        // report it as unavailable rather than emitting an "available" row with
        // a null best that callers must guard.
        if (entry.status === 'unavailable' || best === null) {
            return {
                request: entry.request,
                status: 'unavailable',
                reason: entry.status === 'unavailable' ? entry.reason : 'error',
                best: null,
                edge: null,
                providerQuotes,
            };
        }
        return {
            request: entry.request,
            status: entry.status,
            best,
            edge,
            providerQuotes,
        };
    });

    return { quotes, summarizable };
}
