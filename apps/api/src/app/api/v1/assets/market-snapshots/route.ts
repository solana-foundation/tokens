import { Effect, Schema } from 'effect';

import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, readJsonBody, SolanaAddress } from '@tokens/effect';
import { tokensGetSearchTokensByAddresses } from '@/lib/cloudrun';
import { partitionRegisteredMints, v1RegisteredOnlyEnabled } from '../_registered-only';


const bodySchema = Schema.Struct({
    mints: Schema.optional(Schema.Array(SolanaAddress)),
    addresses: Schema.optional(Schema.Array(SolanaAddress)),
});

function dedupe(values: readonly string[]): string[] {
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

            const values = body.mints ?? body.addresses ?? [];
            const mints = dedupe(values).slice(0, 250);
            if (mints.length === 0) return [];

            if (!v1RegisteredOnlyEnabled()) {
                return yield* tokensGetSearchTokensByAddresses({ addresses: mints });
            }

            // v1 serves registered assets only: unregistered mints keep their row
            // (one per input, input order) but come back as `token: null`.
            const { registered } = yield* partitionRegisteredMints(mints);
            const rows = registered.length > 0 ? yield* tokensGetSearchTokensByAddresses({ addresses: registered }) : [];
            const byAddress = new Map(rows.map(row => [row.address, row] as const));
            return mints.map(address => byAddress.get(address) ?? { address, token: null, hasMarket: false });
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
