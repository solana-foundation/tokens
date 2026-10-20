import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { BadRequestError } from './api-errors';
import { readJsonBody } from './schema';

function post(body: BodyInit | null, contentType = 'application/json'): Request {
    return new Request('https://api.example.test/x', {
        method: 'POST',
        body,
        headers: contentType ? { 'content-type': contentType } : {},
    });
}

describe('readJsonBody', () => {
    it('returns the parsed JSON for a well-formed body', async () => {
        const json = await Effect.runPromise(readJsonBody(post('{"mints":["a"]}')));
        expect(json).toEqual({ mints: ['a'] });
    });

    it('maps malformed JSON to a 400 BadRequestError carrying the parser reason', async () => {
        const error = (await Effect.runPromise(Effect.flip(readJsonBody(post('{"mints":['))))) as BadRequestError;
        expect(error._tag).toBe('BadRequestError');
        expect(error.message).toBe('Invalid JSON body');
        expect(typeof (error.details as { reason: unknown }).reason).toBe('string');
    });

    it('maps an empty body to the same 400', async () => {
        const error = (await Effect.runPromise(Effect.flip(readJsonBody(post(null))))) as BadRequestError;
        expect(error._tag).toBe('BadRequestError');
        expect(error.message).toBe('Invalid JSON body');
    });

    it('lets the caller pick the message', async () => {
        const error = (await Effect.runPromise(
            Effect.flip(readJsonBody(post('nope'), 'Body must be JSON')),
        )) as BadRequestError;
        expect(error.message).toBe('Body must be JSON');
    });
});
