import { describe, expect, it } from 'bun:test';

import { assertCloudRunEnvOrThrow, loadEnv, resetEnvForTests } from './env';

const ENV_KEYS = [
    'NODE_ENV',
    'VERCEL_ENV',
    'TOKENS_USAGE_LOG_MODE',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
] as const;

function setEnv(key: string, value: string): void {
    (process.env as Record<string, string | undefined>)[key] = value;
}

function deleteEnv(key: string): void {
    delete (process.env as Record<string, string | undefined>)[key];
}

function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
    const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

    for (const key of ENV_KEYS) {
        deleteEnv(key);
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) deleteEnv(key);
        else setEnv(key, value);
    }

    resetEnvForTests();
    try {
        fn();
    } finally {
        resetEnvForTests();
        for (const key of ENV_KEYS) {
            const value = previous.get(key);
            if (value === undefined) deleteEnv(key);
            else setEnv(key, value);
        }
    }
}

describe('loadEnv usage logging mode', () => {
    it('defaults to raw usage logging in local development', () => {
        withEnv({ NODE_ENV: 'development' }, () => {
            expect(loadEnv().usageLogMode).toBe('raw');
        });
    });

    it('defaults to aggregated usage logging in production', () => {
        withEnv({ NODE_ENV: 'production' }, () => {
            expect(loadEnv().usageLogMode).toBe('aggregated');
        });
    });

    it('defaults Vercel preview deployments to raw usage logging', () => {
        withEnv({ NODE_ENV: 'production', VERCEL_ENV: 'preview' }, () => {
            expect(loadEnv().usageLogMode).toBe('raw');
        });
    });

    it('honors an explicit usage logging mode', () => {
        withEnv(
            {
                NODE_ENV: 'development',
                TOKENS_USAGE_LOG_MODE: 'aggregated',
            },
            () => {
                expect(loadEnv().usageLogMode).toBe('aggregated');
            },
        );
    });
});

describe('loadEnv Upstash pairing', () => {
    it('allows both Upstash vars to be unset', () => {
        withEnv({}, () => {
            expect(loadEnv().upstash).toBe(null);
        });
    });

    it('loads Upstash when both URL and token are set', () => {
        withEnv(
            {
                UPSTASH_REDIS_REST_URL: ' https://example.upstash.io ',
                UPSTASH_REDIS_REST_TOKEN: ' token ',
            },
            () => {
                expect(loadEnv().upstash).toEqual({
                    url: 'https://example.upstash.io',
                    token: 'token',
                });
            },
        );
    });

    it('rejects setting only one of the Upstash credentials', () => {
        withEnv({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' }, () => {
            expect(() => loadEnv()).toThrow(/must be set together/);
        });

        withEnv({ UPSTASH_REDIS_REST_TOKEN: 'token' }, () => {
            expect(() => loadEnv()).toThrow(/must be set together/);
        });
    });
});

describe('assertCloudRunEnvOrThrow', () => {
    it('passes when required Cloud Run vars are present', () => {
        withEnv(
            {
                TOKENS_CLOUDRUN_AUTH_TOKEN: 'dev',
                TOKENS_CLOUDRUN_ASSETS_URL: 'https://assets.example',
                TOKENS_CLOUDRUN_PRICES_URL: 'https://prices.example',
                TOKENS_CLOUDRUN_USAGE_URL: 'https://usage.example',
            },
            () => {
                expect(() => assertCloudRunEnvOrThrow()).not.toThrow();
            },
        );
    });

    it('lists every missing required Cloud Run var', () => {
        withEnv({}, () => {
            expect(() => assertCloudRunEnvOrThrow()).toThrow(
                /TOKENS_CLOUDRUN_AUTH_TOKEN, TOKENS_CLOUDRUN_ASSETS_URL, TOKENS_CLOUDRUN_PRICES_URL, TOKENS_CLOUDRUN_USAGE_URL/,
            );
        });
    });
});
