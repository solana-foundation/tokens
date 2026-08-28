import { describe, expect, it } from 'bun:test';
import { Cause, Effect } from 'effect';

import { httpStatusForError, toApiErrorInfo, UpstreamHttpError } from './api-errors';

class FakeDownstreamError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FakeDownstreamError';
    }
}

describe('toApiErrorInfo', () => {
    it('unwraps the cause from UnknownError', async () => {
        const wrapped = await Effect.runPromise(
            Effect.tryPromise(() => Promise.reject(new Error('write CONNECTION_CLOSED 172.20.2.3:5432'))).pipe(
                Effect.flip,
            ),
        );
        const info = toApiErrorInfo(wrapped);
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toBe('write CONNECTION_CLOSED 172.20.2.3:5432');
    });

    it('keeps the cause details when unwrapping a typed cause', async () => {
        const wrapped = await Effect.runPromise(
            Effect.tryPromise(() =>
                Promise.reject({ _tag: 'FetchFailedError', message: 'fetch failed', details: { service: 'cloud-run' } }),
            ).pipe(Effect.flip),
        );
        const info = toApiErrorInfo(wrapped);
        expect(info.message).toBe('fetch failed');
        expect(info.details).toEqual({ causeTag: 'FetchFailedError', causeDetails: { service: 'cloud-run' } });
    });

    it('passes tagged errors through unchanged', () => {
        const info = toApiErrorInfo({ _tag: 'NotFoundError', message: 'missing', details: { id: 'x' } });
        expect(info).toEqual({ _tag: 'NotFoundError', message: 'missing', details: { id: 'x' } });
    });

    it('passes through tagged error classes', () => {
        const info = toApiErrorInfo(
            new UpstreamHttpError({ message: 'upstream said no', service: 'svc', status: 502 }),
        );
        expect(info._tag).toBe('UpstreamHttpError');
        expect(info.message).toBe('upstream said no');
    });

    it('surfaces the Error subclass name as the causeTag when unwrapping', () => {
        const original = new FakeDownstreamError('downstream timed out after 4000ms');
        const wrapped = new Cause.UnknownError(original, 'An unknown error occurred');

        const info = toApiErrorInfo(wrapped);
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toBe('downstream timed out after 4000ms');
        expect(info.details).toEqual({ causeTag: 'FakeDownstreamError' });
    });

    it('surfaces the innermost message through nested UnknownError chains', () => {
        const original = new FakeDownstreamError('inner failure');
        const wrapped = new Cause.UnknownError(new Cause.UnknownError(original, 'An unknown error occurred'), 'An unknown error occurred');

        const info = toApiErrorInfo(wrapped);
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toBe('inner failure');
    });

    it('unwraps UnknownError wrapping a non-Error value', () => {
        const wrapped = new Cause.UnknownError('plain string reason', 'An unknown error occurred');
        const info = toApiErrorInfo(wrapped);
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toBe('plain string reason');
    });

    it('keeps the generic message when UnknownError wraps nothing useful', () => {
        const wrapped = new Cause.UnknownError(undefined, 'An unknown error occurred');
        const info = toApiErrorInfo(wrapped);
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toBe('An unknown error occurred');
    });

    it('uses the Error subclass name as the tag', () => {
        const info = toApiErrorInfo(new FakeDownstreamError('boom'));
        expect(info._tag).toBe('FakeDownstreamError');
        expect(info.message).toBe('boom');
    });

    it('keeps the plain Error tag for base errors', () => {
        const info = toApiErrorInfo(new Error('boom'));
        expect(info._tag).toBe('Error');
    });

    it('serializes plain-object errors instead of "[object Object]"', () => {
        const info = toApiErrorInfo({ code: 'ECONNRESET' });
        expect(info._tag).toBe('UnknownError');
        expect(info.message).toContain('ECONNRESET');
    });
});

describe('httpStatusForError', () => {
    it('maps wrapped downstream errors to 500', () => {
        const wrapped = new Cause.UnknownError(new FakeDownstreamError('timeout'), 'An unknown error occurred');
        expect(httpStatusForError(wrapped)).toBe(500);
    });

    it('keeps 500 for UnknownError regardless of the inner tag', () => {
        // Unwrapping surfaces the cause in message/details but does not re-map
        // the outer tag — a promise-thrown typed error is still a defect-shaped
        // failure, not a deliberate typed failure.
        const wrapped = new Cause.UnknownError({ _tag: 'BadRequestError', message: 'bad input' }, 'An unknown error occurred');
        expect(httpStatusForError(wrapped)).toBe(500);
    });

    it('maps a saturated backend (CloudRun 429) to 429', () => {
        expect(httpStatusForError({ _tag: 'CloudRunHttpError', message: 'HTTP 429', status: 429 })).toBe(429);
    });

    it('keeps 500 for other CloudRun HTTP failures', () => {
        expect(httpStatusForError({ _tag: 'CloudRunHttpError', message: 'HTTP 503', status: 503 })).toBe(500);
    });

    it('maps CloudRun timeouts to 504', () => {
        expect(httpStatusForError({ _tag: 'CloudRunTimeoutError', message: 'timed out after 15000ms' })).toBe(504);
    });
});
