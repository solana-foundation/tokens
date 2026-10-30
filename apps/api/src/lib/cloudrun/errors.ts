import { Data } from 'effect';
import type { MissingEnvError, UpstreamDataError } from '@tokens/effect';
import type { CloudRunCallKind, CloudRunService } from './client';

/** Upstream responded with a non-2xx status. */
export class CloudRunHttpError extends Data.TaggedError('CloudRunHttpError')<{
    message: string;
    service: CloudRunService;
    kind: CloudRunCallKind;
    callName: string;
    status: number;
    body?: string;
}> {}

/** The call exceeded its timeout (the in-flight fetch is interrupted). */
export class CloudRunTimeoutError extends Data.TaggedError('CloudRunTimeoutError')<{
    message: string;
    service: CloudRunService;
    kind: CloudRunCallKind;
    callName: string;
    timeoutMs: number;
}> {}

/** Network failure, or the upstream broke the JSON contract. */
export class CloudRunTransportError extends Data.TaggedError('CloudRunTransportError')<{
    message: string;
    service: CloudRunService;
    kind: CloudRunCallKind;
    callName: string;
    cause?: string;
}> {}

export type CloudRunError =
    | CloudRunHttpError
    | CloudRunTimeoutError
    | CloudRunTransportError
    | MissingEnvError
    | UpstreamDataError;

/**
 * Our services answer a call name they do not know with JSON
 * `{ error: "unknown query: <name>" }` (404). That is the only 404 our own
 * code produces on the `/query|/mutation/<name>` paths.
 */
export function isUnknownCloudRunCall(error: unknown): boolean {
    const tagged = error as { _tag?: unknown; status?: unknown; body?: unknown };
    if (tagged?._tag !== 'CloudRunHttpError' || tagged.status !== 404) return false;
    if (typeof tagged.body !== 'string') return false;
    try {
        const parsed = JSON.parse(tagged.body) as { error?: unknown };
        return typeof parsed?.error === 'string' && parsed.error.startsWith('unknown ');
    } catch {
        return false;
    }
}

/**
 * Cloud Run's Google frontend occasionally answers a freshly deployed
 * revision with its own HTML "404 Page not found" page before the request
 * reaches the container (2026-10-30: ~5% of calls to a new usage revision for
 * 22 minutes, zero 404s in the service's own request logs). Such a request
 * never ran, so replaying it is safe — even for a mutation. Any 404 whose
 * body is not our JSON shape is treated as this.
 */
export function isCloudRunFrontendNotFound(error: unknown): boolean {
    const tagged = error as { _tag?: unknown; status?: unknown };
    return tagged?._tag === 'CloudRunHttpError' && tagged.status === 404 && !isUnknownCloudRunCall(error);
}

/** Timeouts and network failures are transient; upstream 5xx is transient-shaped. 4xx is caller/data-dependent. */
export function isRetryableCloudRunError(error: CloudRunError): boolean {
    switch (error._tag) {
        case 'CloudRunTimeoutError':
        case 'CloudRunTransportError':
            return true;
        case 'CloudRunHttpError':
            return error.status >= 500;
        case 'MissingEnvError':
        case 'UpstreamDataError':
            return false;
    }
}
