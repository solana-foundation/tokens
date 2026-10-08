import { describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { loadSingletonIdentity } = await import('./_singleton-identity');
type SingletonIdentityDeps = import('./_singleton-identity').SingletonIdentityDeps;

const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function deps(overrides: Partial<SingletonIdentityDeps> = {}): SingletonIdentityDeps & { calls: string[] } {
    const calls: string[] = [];
    const record =
        <K extends keyof SingletonIdentityDeps>(name: string, key: K): SingletonIdentityDeps[K] =>
        ((mint: string) => {
            calls.push(name);
            const loader = overrides[key];
            return loader ? loader(mint) : Effect.succeed(null);
        }) as SingletonIdentityDeps[K];
    return {
        calls,
        loadToken: record('token', 'loadToken'),
        loadVariantMarket: record('market', 'loadVariantMarket'),
        loadProviderMetadata: record('provider', 'loadProviderMetadata'),
    };
}

describe('loadSingletonIdentity', () => {
    it('prefers the legacy tokens row and stops there', async () => {
        const d = deps({
            loadToken: () => Effect.succeed({ symbol: 'JUP', name: 'Jupiter', decimals: 6, logoUri: 'https://x/jup.png' }),
        });
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, {}, d));
        expect(identity).toEqual({
            symbol: 'JUP',
            name: 'Jupiter',
            decimals: 6,
            logoURI: 'https://x/jup.png',
            source: 'tokens',
        });
        expect(d.calls).toEqual(['token']);
    });

    it('falls back to the variant-market snapshot when there is no tokens row', async () => {
        const d = deps({
            loadVariantMarket: () => Effect.succeed({ symbol: 'JUP', name: 'Jupiter', decimals: 6, logoURI: 'https://cdn/jup.webp' }),
        });
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, {}, d));
        expect(identity?.source).toBe('variant_market');
        expect(identity?.symbol).toBe('JUP');
        expect(identity?.logoURI).toBe('https://cdn/jup.webp');
        expect(d.calls).toEqual(['token', 'market']);
    });

    it('treats a touch-only snapshot (no symbol/name) as missing and asks the provider', async () => {
        const d = deps({
            loadVariantMarket: () => Effect.succeed({ symbol: null, name: null, decimals: null }),
            loadProviderMetadata: () =>
                Effect.succeed({ address: MINT, symbol: 'JUP', name: 'Jupiter', decimals: 6, logoURI: null }),
        });
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, {}, d));
        expect(identity?.source).toBe('provider');
        expect(identity?.name).toBe('Jupiter');
        expect(d.calls).toEqual(['token', 'market', 'provider']);
    });

    it('uses a caller-provided snapshot instead of fetching one', async () => {
        const d = deps();
        const identity = await Effect.runPromise(
            loadSingletonIdentity(MINT, { variantMarket: { symbol: 'SKR', name: 'Seeker' } }, d),
        );
        expect(identity?.symbol).toBe('SKR');
        expect(identity?.source).toBe('variant_market');
        expect(d.calls).toEqual(['token']);
    });

    it('a caller-provided null snapshot skips the market lookup but still tries the provider', async () => {
        const d = deps();
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, { variantMarket: null }, d));
        expect(identity).toBeNull();
        expect(d.calls).toEqual(['token', 'provider']);
    });

    it('swallows loader failures and continues down the chain', async () => {
        const d = deps({
            loadToken: () => Effect.fail(new Error('cloud run down')),
            loadVariantMarket: () => Effect.fail(new Error('cloud run down')),
            loadProviderMetadata: () => Effect.fail(new Error('birdeye 429')),
        });
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, {}, d));
        expect(identity).toBeNull();
        expect(d.calls).toEqual(['token', 'market', 'provider']);
    });

    it('normalizes whitespace-only identity to null fields', async () => {
        const d = deps({ loadToken: () => Effect.succeed({ symbol: '  ', name: ' Jupiter ' }) });
        const identity = await Effect.runPromise(loadSingletonIdentity(MINT, {}, d));
        expect(identity?.symbol).toBeNull();
        expect(identity?.name).toBe('Jupiter');
    });
});
