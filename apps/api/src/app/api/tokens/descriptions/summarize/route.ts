import { Effect } from 'effect';
import { createHash } from 'node:crypto';

import { tokenDescriptionSummariesGetByAddress, tokensGetByAddress } from '@/lib/cloudrun';
import { CURATED_LIST_ORDER, type CuratedListSlug as CuratedTokenListId } from '@tokens/asset-registry/curated-lists';
import { JsonParseError, MissingEnvError, NotFoundError } from '@tokens/effect';
import { fetchJsonWithRetry } from '@tokens/effect';
import { route } from '@/effect/next-route';
import {
    decodeUnknownOrBadRequest,
    NonNegativeIntFromString,
    PositiveIntFromString,
    SolanaAddress,
} from '@tokens/effect';
import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';

export const runtime = 'nodejs';

type CuratedTokenCategoryId = 'all' | CuratedTokenListId;

function isCuratedTokenCategoryId(value: string): value is CuratedTokenCategoryId {
    if (value === 'all') return true;
    return CURATED_LIST_ORDER.includes(value as CuratedTokenListId);
}

function normalizeSourceDescription(value: string): string {
    const withLineBreaks = value.replaceAll(/<br\s*\/?>/gi, '\n').replaceAll(/<\/p>/gi, '\n');
    const withoutTags = withLineBreaks.replaceAll(/<[^>]+>/g, ' ');
    return withoutTags.replaceAll(/\s+/g, ' ').trim();
}

function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface OpenAIChatCompletionResponse {
    choices?: Array<{
        message?: { content?: string };
    }>;
}

function createOpenAISummary(args: {
    apiKey: string;
    model: string;
    name: string;
    symbol: string;
    description: string;
}) {
    const body = JSON.stringify({
        model: args.model,
        temperature: 0.2,
        max_tokens: 140,
        messages: [
            {
                role: 'system',
                content:
                    'Rewrite token/project descriptions into a consistent, neutral format for a UI "About" section. Output plain text only.',
            },
            {
                role: 'user',
                content: [
                    'Task: Write a single-paragraph summary for a token.',
                    '',
                    'Rules:',
                    '- Exactly 1 paragraph (no line breaks).',
                    '- 2–3 sentences.',
                    '- 280–420 characters.',
                    '- Neutral tone, no hype, no price talk, no predictions.',
                    '- Avoid lists, markdown, quotes, and emojis.',
                    '- Start with: "<NAME> (<SYMBOL>) is ..."',
                    '',
                    `NAME: ${args.name}`,
                    `SYMBOL: ${args.symbol}`,
                    '',
                    'Source description:',
                    args.description,
                ].join('\n'),
            },
        ],
    });

    return fetchJsonWithRetry<OpenAIChatCompletionResponse>({
        url: 'https://api.openai.com/v1/chat/completions',
        service: 'openai',
        init: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${args.apiKey}`,
                'Content-Type': 'application/json',
            },
            body,
        },
        maxRetries: 2,
        baseDelay: '500 millis',
    }).pipe(
        Effect.flatMap(json => {
            const content = json?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || content.trim().length === 0) {
                return Effect.fail(new JsonParseError({ message: 'OpenAI response missing message content' }));
            }
            return Effect.succeed(content);
        }),
    );
}

export const POST = route((request: Request) =>
    Effect.gen(function* () {
        // Avoid exposing a bulk-write endpoint in production by default.
        if (process.env.NODE_ENV === 'production') {
            return yield* Effect.fail(new NotFoundError({ message: 'Not found' }));
        }

        const openAiApiKey = process.env.OPENAI_API_KEY;
        if (!openAiApiKey) {
            return yield* Effect.fail(
                new MissingEnvError({ name: 'OPENAI_API_KEY', message: 'OPENAI_API_KEY is not set' }),
            );
        }

        const url = new URL(request.url);
        const searchParams = url.searchParams;

        const rawAddressParam = (searchParams.get('address') ?? '').trim();
        const addressParam = rawAddressParam
            ? yield* decodeUnknownOrBadRequest(SolanaAddress, rawAddressParam, 'Invalid address')
            : null;

        const rawListId = searchParams.get('list') ?? 'all';
        const listId: CuratedTokenCategoryId = isCuratedTokenCategoryId(rawListId) ? rawListId : 'all';

        const offset = yield* decodeUnknownOrBadRequest(
            NonNegativeIntFromString,
            searchParams.get('offset') ?? '0',
            'Invalid offset',
        );
        const limitUnclamped = yield* decodeUnknownOrBadRequest(
            PositiveIntFromString,
            searchParams.get('limit') ?? '1',
            'Invalid limit',
        );
        const limit = Math.min(limitUnclamped, 25);

        const force = searchParams.get('force') === '1';
        const dryRun = searchParams.get('dryRun') === '1';
        const model = (searchParams.get('model') ?? 'gpt-4o-mini').trim() || 'gpt-4o-mini';
        const promptVersion = 1;

        const { addresses: allAddresses } = yield* Effect.tryPromise(() => getEffectiveCuratedAddresses(listId));

        const addresses = addressParam ? [addressParam] : allAddresses.slice(offset, offset + limit);

        type Result =
            | {
                  address: string;
                  ok: true;
                  summary: string;
                  skipped: false;
                  reason: null;
              }
            | {
                  address: string;
                  ok: true;
                  summary: null;
                  skipped: true;
                  reason: 'missing_token' | 'missing_description' | 'up_to_date';
              }
            | {
                  address: string;
                  ok: false;
                  summary: null;
                  skipped: false;
                  reason: 'error';
                  message: string;
              };

        function resultSkipped(
            address: string,
            reason: 'missing_token' | 'missing_description' | 'up_to_date',
        ): Result {
            return { address, ok: true, summary: null, skipped: true, reason };
        }

        function resultOk(address: string, summary: string): Result {
            return { address, ok: true, summary, skipped: false, reason: null };
        }

        function resultError(address: string, message: string): Result {
            return { address, ok: false, summary: null, skipped: false, reason: 'error', message };
        }

        function summarizeAddress(address: string): Effect.Effect<Result, never> {
            return Effect.gen(function* () {
                const token = yield* tokensGetByAddress({ address });
                if (!token) return resultSkipped(address, 'missing_token');

                const name = (token.name ?? '').trim();
                const symbol = (token.symbol ?? '').trim();
                if (!name || !symbol) {
                    return resultError(address, 'Token is missing name or symbol');
                }

                const rawDescription = token.description?.trim() ?? '';
                if (!rawDescription) {
                    return resultSkipped(address, 'missing_description');
                }

                const normalizedSource = normalizeSourceDescription(rawDescription);
                if (!normalizedSource) {
                    return resultSkipped(address, 'missing_description');
                }

                const sourceHash = sha256Hex(normalizedSource);
                const existingSummary = yield* tokenDescriptionSummariesGetByAddress({ address });
                if (!force && existingSummary?.sourceHash === sourceHash) {
                    return resultSkipped(address, 'up_to_date');
                }

                const summaryRaw = yield* createOpenAISummary({
                    apiKey: openAiApiKey!,
                    model,
                    name,
                    symbol,
                    description: normalizedSource.slice(0, 4000),
                });

                const summary = summaryRaw.replaceAll(/\s+/g, ' ').trim();
                if (!summary) {
                    return resultError(address, 'OpenAI returned an empty summary');
                }

                // ponytail: write path removed with Convex — no Cloud Run mutation exists yet.
                // Add a `tokenDescriptionSummariesUpsert` cloudrun-assets handler and re-enable
                // when the summarizer needs to run outside dry-run mode again.
                void sourceHash;
                void promptVersion;
                void dryRun;

                return resultOk(address, summary);
            }).pipe(
                Effect.catch(error =>
                    Effect.succeed(resultError(address, error instanceof Error ? error.message : String(error))),
                ),
            );
        }

        const results: Result[] = [];
        for (const address of addresses) {
            results.push(yield* summarizeAddress(address));
        }

        const okCount = results.filter(r => r.ok).length;
        const failedCount = results.length - okCount;
        const skippedCount = results.filter(r => r.ok && r.skipped).length;
        const generatedCount = results.filter(r => r.ok && !r.skipped).length;

        return {
            listId,
            offset: addressParam ? null : offset,
            limit: addressParam ? null : limit,
            processed: addresses.length,
            generated: generatedCount,
            skipped: skippedCount,
            failed: failedCount,
            dryRun,
            model,
            promptVersion,
            results:
                addressParam && results.length === 1
                    ? results
                    : results.map(r => (r.ok && !r.skipped ? { ...r, summary: '(omitted)' } : r)),
            nextOffset:
                addressParam || offset + limit >= allAddresses.length
                    ? null
                    : Math.min(offset + limit, allAddresses.length),
        };
    }),
);
