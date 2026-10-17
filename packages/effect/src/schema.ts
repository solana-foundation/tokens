import { Effect, Schema } from 'effect';
import { BadRequestError, UpstreamDataError } from './api-errors';

// -----------------------------------------------------------------------------
// Common schemas
// -----------------------------------------------------------------------------

// Base58 (no 0,O,I,l) and common Solana mint length range.
export const SolanaAddress = Schema.String.check(Schema.isPattern(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));

export const TimeInterval = Schema.Literals(['1m', '5m', '15m', '1H', '4H', '1D', '1W']);

export const NonEmptyString = Schema.NonEmptyString;

export const NonNegativeIntFromString = Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
);

export const PositiveIntFromString = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

// -----------------------------------------------------------------------------
// Decode helpers (Schema -> BadRequestError)
// -----------------------------------------------------------------------------

function parseErrorToMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
    }
    return String(error);
}

export function decodeUnknownOrBadRequest<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    input: unknown,
    message: string,
): Effect.Effect<S['Type'], BadRequestError, S['DecodingServices']> {
    return Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError(parseError => new BadRequestError({ message, details: parseErrorToMessage(parseError) })),
    );
}

/**
 * Read a JSON request body. A body that is empty or not valid JSON is the
 * caller's mistake, so it maps to a 400 `BadRequestError` (with the parser's
 * reason in `details`) instead of surfacing as an `UnknownError` 500.
 */
export function readJsonBody(request: Request, message = 'Invalid JSON body'): Effect.Effect<unknown, BadRequestError> {
    return Effect.tryPromise({
        try: () => request.json() as Promise<unknown>,
        catch: error =>
            new BadRequestError({
                message,
                details: { reason: error instanceof Error ? error.message : String(error) },
            }),
    });
}

export function decodeRequiredSearchParam<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    params: URLSearchParams,
    key: string,
): Effect.Effect<S['Type'], BadRequestError, S['DecodingServices']> {
    const raw = params.get(key);
    if (raw == null) return Effect.fail(new BadRequestError({ message: `${key} is required` }));
    return decodeUnknownOrBadRequest(schema, raw, `Invalid ${key}`);
}

export function decodeOptionalSearchParam<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    params: URLSearchParams,
    key: string,
): Effect.Effect<S['Type'] | null, BadRequestError, S['DecodingServices']> {
    const raw = params.get(key);
    if (raw == null) return Effect.succeed(null);
    return decodeUnknownOrBadRequest(schema, raw, `Invalid ${key}`);
}

// -----------------------------------------------------------------------------
// Upstream (outbound) response decoding
// -----------------------------------------------------------------------------

/**
 * Strictly decode an upstream response. Failure becomes a tagged
 * `UpstreamDataError` (mapped to 500). Note that Schema decoding drops excess
 * properties, so additive upstream changes never fail — only missing/wrong
 * fields do. Use for first-party contracts (e.g. our Cloud Run services).
 */
export function decodeUpstreamOrFail<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    service: string,
): (input: unknown) => Effect.Effect<S['Type'], UpstreamDataError, S['DecodingServices']> {
    return input =>
        Schema.decodeUnknownEffect(schema)(input).pipe(
            Effect.mapError(
                parseError =>
                    new UpstreamDataError({
                        message: `${service} response failed schema validation`,
                        service,
                        issue: parseErrorToMessage(parseError),
                    }),
            ),
        );
}

/**
 * Shadow-mode decode for third-party responses: on mismatch, log a structured
 * `upstream_decode_failed` event and return the raw input (cast) so behavior
 * is unchanged while schemas bed in. Flip callers to `decodeUpstreamOrFail`
 * once the event is quiet in logs.
 */
export function decodeUpstreamOrWarn<S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    service: string,
): (input: unknown) => Effect.Effect<S['Type'], never, S['DecodingServices']> {
    return input =>
        Schema.decodeUnknownEffect(schema)(input).pipe(
            Effect.catch(parseError =>
                Effect.sync(() => {
                    console.warn(
                        JSON.stringify({
                            event: 'upstream_decode_failed',
                            service,
                            issue: parseErrorToMessage(parseError).slice(0, 512),
                        }),
                    );
                    return input as S['Type'];
                }),
            ),
        );
}
