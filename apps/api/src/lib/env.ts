/**
 * Centralized, validated environment access for the API service.
 *
 * `loadEnv()` is called once at boot from `src/instrumentation.ts` so
 * misconfiguration fails at startup with a clear message instead of
 * surfacing as cryptic request-time errors.
 */

export interface ApiEnv {
    /** Upstash Redis REST credentials — both set, or null (rate limiting disabled / fail-open). */
    upstash: { url: string; token: string } | null;
    /** Cloud Run backend — all required vars set, or null (asserted at boot). */
    cloudRun: {
        authToken: string;
        urls: { assets: string; prices: string; usage: string; admin?: string };
        timeoutMs?: number;
    } | null;
    // Optional integrations — absence disables the corresponding feature.
    birdeyeApiKey: string | null;
    coingeckoApiKey: string | null;
    openaiApiKey: string | null;
    ddApiKey: string | null;
    cacheWarmSecret: string | null;
    usageIngestSecret: string | null;
    playgroundProxySecret: string | null;
    usageLogMode: 'aggregated' | 'raw' | 'off';
    usageRawSampleRate: number;
    authCacheTtlSeconds: number;
    usageAggregationTtlSeconds: number;
    /**
     * Default per-key rate limit / quota applied when a key has no explicit
     * per-project override. Tunable via env so real limits can be set before
     * offering the API externally without a code change. Fallbacks preserve
     * the current "launch mode" behavior.
     */
    defaultRateLimit: { requests: number; windowSeconds: number };
    defaultQuota: { requestsPerMonth: number };
}

function readTrimmed(name: string): string | null {
    const raw = process.env[name];
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return value.length > 0 ? value : null;
}

function readNumber(name: string, fallback: number, min: number, max: number): number {
    const raw = readTrimmed(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        // A typo'd value silently becoming the fallback is how misconfiguration
        // hides for months — say so once, loudly, then proceed with the fallback.
        console.warn(JSON.stringify({ event: 'env_invalid_value', name, raw, used: fallback }));
        return fallback;
    }
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) {
        console.warn(JSON.stringify({ event: 'env_invalid_value', name, raw, used: clamped }));
    }
    return clamped;
}

function getDefaultUsageLogMode(): ApiEnv['usageLogMode'] {
    const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
    const vercelEnv = process.env.VERCEL_ENV?.trim().toLowerCase();

    if (nodeEnv !== 'production' || vercelEnv === 'development' || vercelEnv === 'preview') {
        return 'raw';
    }

    return 'aggregated';
}

function readUsageLogMode(): ApiEnv['usageLogMode'] {
    const raw = (readTrimmed('TOKENS_USAGE_LOG_MODE') ?? getDefaultUsageLogMode()).toLowerCase();
    if (raw === 'raw' || raw === 'off' || raw === 'aggregated') return raw;
    return getDefaultUsageLogMode();
}

function readCloudRunEnv(): ApiEnv['cloudRun'] {
    const authToken = readTrimmed('TOKENS_CLOUDRUN_AUTH_TOKEN');
    const assets = readTrimmed('TOKENS_CLOUDRUN_ASSETS_URL');
    const prices = readTrimmed('TOKENS_CLOUDRUN_PRICES_URL');
    const usage = readTrimmed('TOKENS_CLOUDRUN_USAGE_URL');
    if (!authToken || !assets || !prices || !usage) return null;

    const admin = readTrimmed('TOKENS_CLOUDRUN_ADMIN_URL');
    const timeoutRaw = readTrimmed('TOKENS_CLOUDRUN_TIMEOUT_MS');
    const timeout = timeoutRaw !== null ? Number(timeoutRaw) : Number.NaN;

    return {
        authToken,
        urls: { assets, prices, usage, ...(admin ? { admin } : {}) },
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    };
}

let cached: ApiEnv | null = null;

/**
 * Validate and cache the environment. Throws on invalid configuration.
 * Safe to call multiple times; only validates once.
 */
export function loadEnv(): ApiEnv {
    if (cached) return cached;

    const upstashUrl = readTrimmed('UPSTASH_REDIS_REST_URL');
    const upstashToken = readTrimmed('UPSTASH_REDIS_REST_TOKEN');
    if ((upstashUrl === null) !== (upstashToken === null)) {
        throw new Error(
            '[env] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set together (or both unset).',
        );
    }

    cached = {
        upstash: upstashUrl && upstashToken ? { url: upstashUrl, token: upstashToken } : null,
        cloudRun: readCloudRunEnv(),
        birdeyeApiKey: readTrimmed('BIRDEYE_API_KEY'),
        coingeckoApiKey: readTrimmed('COINGECKO_API_KEY'),
        openaiApiKey: readTrimmed('OPENAI_API_KEY'),
        ddApiKey: readTrimmed('DD_API_KEY'),
        cacheWarmSecret: readTrimmed('TOKENS_CACHE_WARM_SECRET'),
        usageIngestSecret: readTrimmed('TOKENS_USAGE_INGEST_SECRET'),
        playgroundProxySecret: readTrimmed('TOKENS_PLAYGROUND_PROXY_SECRET'),
        usageLogMode: readUsageLogMode(),
        usageRawSampleRate: readNumber('TOKENS_USAGE_RAW_SAMPLE_RATE', 0, 0, 1),
        authCacheTtlSeconds: Math.floor(readNumber('TOKENS_AUTH_CACHE_TTL_SECONDS', 60, 0, 300)),
        usageAggregationTtlSeconds: Math.floor(
            readNumber('TOKENS_USAGE_AGGREGATION_TTL_SECONDS', 172_800, 60, 604_800),
        ),
        defaultRateLimit: {
            requests: Math.floor(readNumber('TOKENS_DEFAULT_RATE_LIMIT_REQUESTS', 500, 1, 10_000_000)),
            windowSeconds: Math.floor(readNumber('TOKENS_DEFAULT_RATE_LIMIT_WINDOW_SECONDS', 10, 1, 3_600)),
        },
        defaultQuota: {
            requestsPerMonth: Math.floor(
                readNumber('TOKENS_DEFAULT_QUOTA_PER_MONTH', 1_000_000_000, 1, 100_000_000_000),
            ),
        },
    };
    return cached;
}

/** Reset the cached env (test helper). */
export function resetEnvForTests(): void {
    cached = null;
}

/** Boot-only assertion that Cloud Run env is complete. */
export function assertCloudRunEnvOrThrow(): void {
    if (loadEnv().cloudRun !== null) return;
    const missing = (
        [
            'TOKENS_CLOUDRUN_AUTH_TOKEN',
            'TOKENS_CLOUDRUN_ASSETS_URL',
            'TOKENS_CLOUDRUN_PRICES_URL',
            'TOKENS_CLOUDRUN_USAGE_URL',
        ] as const
    ).filter(name => readTrimmed(name) === null);
    throw new Error(
        `[env] required Cloud Run vars missing: ${missing.join(', ')}. TOKENS_CLOUDRUN_ADMIN_URL is optional (admin service stays IAM-locked).`,
    );
}
