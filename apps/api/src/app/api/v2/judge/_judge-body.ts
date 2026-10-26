/**
 * Body contract for `POST /v2/judge`: the caller brings candidates (from
 * their own search, Birdeye, Jupiter, a watchlist…) and we judge them.
 *
 * Caller fields are *claims* with the same trust as the live provider's
 * search hits today: symbol and name are attacker-controlled metadata that
 * the protected-symbol index and attestations evaluate, and market fields
 * are overlaid by our own snapshots during enrichment exactly as provider
 * fields are (`??=` semantics: ours win when present).
 */

import { Effect, Schema } from 'effect';

import { BadRequestError, decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';

import { MAX_CANDIDATES, newRawCandidate, type RawCandidate } from '@/lib/judgment/candidates';

/** Hard cap on candidates per call — the same cap the gathered routes apply. */
export const MAX_JUDGE_CANDIDATES = MAX_CANDIDATES;

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

export const JudgeCandidateSchema = Schema.Struct({
    mint: SolanaAddress,
    symbol: optionalText,
    name: optionalText,
    decimals: optionalNumber,
    logoURI: optionalText,
    price: optionalNumber,
    liquidityUsd: optionalNumber,
    volume24hUsd: optionalNumber,
    marketCapUsd: optionalNumber,
    priceChange24hPercent: optionalNumber,
    holderCount: optionalNumber,
    /** ISO 8601 or epoch ms; unparseable values are treated as unknown. */
    createdAt: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    // Further claims a caller on Birdeye / Jupiter / Webacy already has.
    top10HoldersPercent: optionalNumber,
    uniqueWallets24h: optionalNumber,
    trades24h: optionalNumber,
    fdv: optionalNumber,
    circulatingSupply: optionalNumber,
    totalSupply: optionalNumber,
    mintable: Schema.optional(Schema.NullOr(Schema.Boolean)),
    freezable: Schema.optional(Schema.NullOr(Schema.Boolean)),
    lpLockedPercent: optionalNumber,
});

export type JudgeCandidateInput = typeof JudgeCandidateSchema.Type;

/**
 * Only `candidates` is typed here. `q`, `policy`, the gate overrides,
 * `limit` and `includeSuppressed` are read through the shared judged-search
 * parser (`paramsFromBody`), so a body field gets the same validation and
 * error message as its query-string twin.
 */
export const JudgeBodySchema = Schema.Struct({
    candidates: Schema.Array(JudgeCandidateSchema),
});

function finite(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function isoOrNull(ms: number): string | null {
    // Outside the representable Date range `getTime()` is NaN and
    // `toISOString()` would throw — a bad timestamp is unknown, not a 500.
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function createdAtIso(value: string | number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return isoOrNull(value > 1e12 ? value : value * 1000);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? isoOrNull(parsed) : null;
}

/** One body candidate → the raw shape enrichment consumes. */
export function rawFromJudgeCandidate(input: JudgeCandidateInput): RawCandidate {
    const raw = newRawCandidate(input.mint);
    raw.sources = ['caller'];
    raw.symbol = text(input.symbol);
    raw.name = text(input.name);
    raw.decimals = finite(input.decimals);
    raw.logoURI = text(input.logoURI);
    raw.price = finite(input.price);
    raw.liquidityUsd = finite(input.liquidityUsd);
    raw.volume24hUsd = finite(input.volume24hUsd);
    raw.marketCapUsd = finite(input.marketCapUsd);
    raw.priceChange24hPercent = finite(input.priceChange24hPercent);
    raw.holderCount = finite(input.holderCount);
    raw.tokenMintTime = createdAtIso(input.createdAt);
    raw.top10HoldersPercent = clampPercent(finite(input.top10HoldersPercent));
    raw.uniqueWallet24h = finite(input.uniqueWallets24h);
    raw.trade24h = finite(input.trades24h);
    raw.fdv = finite(input.fdv);
    raw.circulatingSupply = finite(input.circulatingSupply);
    raw.totalSupply = finite(input.totalSupply);
    raw.mintable = typeof input.mintable === 'boolean' ? input.mintable : null;
    raw.freezable = typeof input.freezable === 'boolean' ? input.freezable : null;
    raw.lpLockedPercent = clampPercent(finite(input.lpLockedPercent));
    return raw;
}

function clampPercent(value: number | null): number | null {
    return value === null ? null : Math.max(0, Math.min(100, value));
}

/**
 * Validate the body and turn it into raw candidates. Duplicate mints keep the
 * first occurrence (the caller's own ranking order is preserved). An empty
 * list or more than `MAX_JUDGE_CANDIDATES` is a 400 with a `details.code`.
 */
export function parseJudgeBody(
    json: unknown,
): Effect.Effect<{ body: Record<string, unknown>; raws: RawCandidate[] }, BadRequestError> {
    return Effect.gen(function* () {
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: 'Invalid body: expected a JSON object',
                    details: { code: 'invalid_body' },
                }),
            );
        }
        const body = json as Record<string, unknown>;
        if (!Array.isArray(body.candidates)) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: 'Invalid body: candidates must be an array of { mint, ... }',
                    details: { code: 'invalid_candidates' },
                }),
            );
        }
        if (body.candidates.length === 0) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: 'Invalid body: candidates must not be empty',
                    details: { code: 'invalid_candidates' },
                }),
            );
        }
        if (body.candidates.length > MAX_JUDGE_CANDIDATES) {
            return yield* Effect.fail(
                new BadRequestError({
                    message: `Too many candidates (max ${MAX_JUDGE_CANDIDATES})`,
                    details: {
                        code: 'too_many_candidates',
                        max: MAX_JUDGE_CANDIDATES,
                        received: body.candidates.length,
                    },
                }),
            );
        }

        const decoded = yield* decodeUnknownOrBadRequest(
            JudgeBodySchema,
            { candidates: body.candidates },
            'Invalid candidates: each needs a Solana mint; market fields must be numbers or null',
        );

        const seen = new Set<string>();
        const raws: RawCandidate[] = [];
        for (const input of decoded.candidates) {
            if (seen.has(input.mint)) continue;
            seen.add(input.mint);
            raws.push(rawFromJudgeCandidate(input));
        }
        return { body, raws };
    });
}
