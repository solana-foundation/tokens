import { Effect, Schema } from 'effect';

import { route } from '@/effect/next-route';
import { tokensGetSearchTokensByAddresses } from '@/lib/cloudrun';
import { decodeUnknownOrBadRequest, readJsonBody, SolanaAddress } from '@tokens/effect';

const bodySchema = Schema.Struct({
    addresses: Schema.Array(SolanaAddress),
});

function dedupeAddresses(values: readonly string[]): string[] {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        unique.push(value);
    }

    return unique;
}

export const POST = route(
    (request: Request) =>
        Effect.gen(function* () {
            const json = yield* readJsonBody(request);
            const body = yield* decodeUnknownOrBadRequest(bodySchema, json, 'Invalid body');

            const addresses = dedupeAddresses(body.addresses).slice(0, 250);
            if (addresses.length === 0) return [];

            return yield* tokensGetSearchTokensByAddresses({ addresses });
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
