import 'server-only';

/**
 * Caches one value for `ttlMs` and collapses concurrent callers onto a single
 * in-flight load.
 *
 * The collapsing matters as much as the caching here: the homepage renders
 * every curated tab at once, so without it a cold cache fires one upstream
 * burst per tab and the keyless CoinGecko and GeckoTerminal tiers answer 429.
 */
export function withTtl<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
    let value: T | null = null;
    let expiresAt = 0;
    let inFlight: Promise<T> | null = null;

    return async () => {
        const now = Date.now();
        if (value !== null && expiresAt > now) return value;

        inFlight ??= load()
            .then(loaded => {
                value = loaded;
                expiresAt = Date.now() + ttlMs;
                return loaded;
            })
            .finally(() => {
                inFlight = null;
            });

        return await inFlight;
    };
}

/** Same contract as `withTtl`, but keyed — one cache entry per argument. */
export function withKeyedTtl<T>(
    ttlMs: number,
    load: (key: string) => Promise<T>,
): (key: string) => Promise<T> {
    const loaders = new Map<string, () => Promise<T>>();

    return async (key: string) => {
        let loader = loaders.get(key);
        if (!loader) {
            loader = withTtl(ttlMs, () => load(key));
            loaders.set(key, loader);
        }
        return await loader();
    };
}
