import { Data } from 'effect';

// -----------------------------------------------------------------------------
// API error envelope (shared server <-> client contract)
// -----------------------------------------------------------------------------

export interface ApiErrorInfo {
    _tag: string;
    message: string;
    details?: unknown;
}

export interface ApiErrorEnvelope {
    error: ApiErrorInfo;
}

// -----------------------------------------------------------------------------
// Tagged errors (typed failures in the Effect error channel)
// -----------------------------------------------------------------------------

/**
 * A non-2xx response from the tokens API, with the upstream error envelope
 * preserved (`error` carries the API's tagged `ApiErrorInfo`).
 */
export class ApiResponseError extends Data.TaggedError('ApiResponseError')<{
    message: string;
    status: number;
    error: ApiErrorInfo;
}> {}

export class BadRequestError extends Data.TaggedError('BadRequestError')<{
    message: string;
    details?: unknown;
}> {}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
    message: string;
    resource?: string;
    details?: unknown;
}> {}

export class UnauthorizedError extends Data.TaggedError('UnauthorizedError')<{
    message: string;
    details?: unknown;
}> {}

export class ForbiddenError extends Data.TaggedError('ForbiddenError')<{
    message: string;
    details?: unknown;
}> {}

export class MissingEnvError extends Data.TaggedError('MissingEnvError')<{
    message: string;
    name: string;
}> {}

export class RateLimitedError extends Data.TaggedError('RateLimitedError')<{
    message: string;
    service: string;
    retryAfterMs?: number;
}> {}

export class UpstreamHttpError extends Data.TaggedError('UpstreamHttpError')<{
    message: string;
    service: string;
    status: number;
    statusText?: string;
    body?: string;
}> {}

export class FetchFailedError extends Data.TaggedError('FetchFailedError')<{
    message: string;
    service: string;
    cause?: string;
}> {}

export class JsonParseError extends Data.TaggedError('JsonParseError')<{
    message: string;
    cause?: string;
    body?: string;
}> {}

/** An upstream response parsed as JSON but failed schema validation. */
export class UpstreamDataError extends Data.TaggedError('UpstreamDataError')<{
    message: string;
    service: string;
    issue?: string;
}> {}

// -----------------------------------------------------------------------------
// Conversions (unknown -> standardized error shape)
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getStringField(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringifyUnknown(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        const json = JSON.stringify(value);
        if (json && json !== '{}') return json.slice(0, 512);
    } catch {
        // fall through to String()
    }
    return String(value);
}

export function toApiErrorInfo(error: unknown): ApiErrorInfo {
    if (isRecord(error)) {
        const tag = getStringField(error, '_tag');
        const message = getStringField(error, 'message');
        const details = 'details' in error ? error.details : undefined;

        if (tag && message) {
            // Effect.tryPromise wraps thrown errors in Cause.UnknownError with a
            // generic message; surface the underlying cause or the log is useless.
            if (tag === 'UnknownError') {
                const cause = 'error' in error ? error.error : 'cause' in error ? error.cause : undefined;
                if (cause !== undefined && cause !== error) {
                    const causeInfo = toApiErrorInfo(cause);
                    return {
                        _tag: tag,
                        message: causeInfo.message,
                        details:
                            details !== undefined
                                ? details
                                : {
                                      causeTag: causeInfo._tag,
                                      ...(causeInfo.details !== undefined ? { causeDetails: causeInfo.details } : {}),
                                  },
                    };
                }
            }
            return {
                _tag: tag,
                message,
                ...(details !== undefined ? { details } : {}),
            };
        }
    }

    if (error instanceof Error) {
        // Prefer the subclass name (e.g. `CloudRunCallError`) over the generic
        // `Error` tag — it is the only machine-readable signal for untyped
        // throws that cross an `Effect.tryPromise` boundary.
        const name = typeof error.name === 'string' ? error.name.trim() : '';
        return { _tag: name && name !== 'Error' ? name : 'Error', message: error.message };
    }

    return { _tag: 'UnknownError', message: stringifyUnknown(error) };
}

export function toErrorEnvelope(error: unknown): ApiErrorEnvelope {
    return { error: toApiErrorInfo(error) };
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
    if (!isRecord(value)) return false;
    if (!('error' in value)) return false;

    const errorValue = value.error;
    if (!isRecord(errorValue)) return false;

    return typeof errorValue._tag === 'string' && typeof errorValue.message === 'string';
}

export function httpStatusForError(error: unknown): number {
    const info = toApiErrorInfo(error);

    switch (info._tag) {
        case 'BadRequestError':
            return 400;
        case 'UnauthorizedError':
            return 401;
        case 'ForbiddenError':
            return 403;
        case 'NotFoundError':
            return 404;
        case 'RateLimitedError':
            return 429;
        case 'CloudRunHttpError':
            // A saturated backend rejecting work (429) is not an internal error —
            // surface it to the caller as 429 so they back off instead of retrying a "500".
            return isRecord(error) && error.status === 429 ? 429 : 500;
        case 'CloudRunTimeoutError':
            return 504;
        case 'UpstreamDataError':
        case 'MissingEnvError':
        case 'UpstreamHttpError':
        case 'FetchFailedError':
        case 'JsonParseError':
        default:
            return 500;
    }
}
