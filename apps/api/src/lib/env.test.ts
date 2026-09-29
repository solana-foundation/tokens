import { describe, expect, it } from 'bun:test';

import { loadEnv, resetEnvForTests } from './env';

const ENV_KEYS = [
    'NODE_ENV',
    'VERCEL_ENV',
    'TOKENS_USAGE_LOG_MODE',
    'TOKENS_USAGE_RAW_SAMPLE_RATE',
    'TOKENS_USAGE_AGGREGATION_TTL_SECONDS',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_CLOUDRUN_ADMIN_URL',
    'TOKENS_CLOUDRUN_TIMEOUT_MS',
] as const;

function setEnv(key: string, value: string): void {
    (process.env as Record<string, string | undefined>)[key] = value;
}

function deleteEnv(key: string): void {
    delete (process.env as Record<string, string | undefined>)[key];
}

function withCapturedWarnings(fn: (warnings: string[]) => void): void {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(String(args[0]));
    };
    try {
        fn(warnings);
    } finally {
        console.warn = original;
    }
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


describe('loadEnv invalid numeric values', () => {
    it('warns loudly when a numeric env is not a number, then uses the fallback', () => {
        withEnv({ TOKENS_USAGE_RAW_SAMPLE_RATE: 'abc' }, () => {
            withCapturedWarnings(warnings => {
                const env = loadEnv();
                expect(env.usageRawSampleRate).toBe(0);
                const events = warnings
                    .map(line => JSON.parse(line) as Record<string, unknown>)
                    .filter(event => event.event === 'env_invalid_value');
                expect(events.length).toBe(1);
                expect(events[0]!.name).toBe('TOKENS_USAGE_RAW_SAMPLE_RATE');
                expect(events[0]!.raw).toBe('abc');
            });
        });
    });

    it('warns when a numeric env is clamped', () => {
        withEnv({ TOKENS_USAGE_RAW_SAMPLE_RATE: '7' }, () => {
            withCapturedWarnings(warnings => {
                const env = loadEnv();
                expect(env.usageRawSampleRate).toBe(1);
                expect(warnings.length).toBe(1);
            });
        });
    });

    it('stays silent for valid values', () => {
        withEnv({ TOKENS_USAGE_RAW_SAMPLE_RATE: '0.5' }, () => {
            withCapturedWarnings(warnings => {
                expect(loadEnv().usageRawSampleRate).toBe(0.5);
                expect(warnings.length).toBe(0);
            });
        });
    });
});

describe('loadEnv usage aggregation guards', () => {
    it('forces raw sampling off in aggregated mode and says so', () => {
        withEnv({ TOKENS_USAGE_LOG_MODE: 'aggregated', TOKENS_USAGE_RAW_SAMPLE_RATE: '0.5' }, () => {
            withCapturedWarnings(warnings => {
                expect(loadEnv().usageRawSampleRate).toBe(0);
                const events = warnings.map(line => JSON.parse(line) as Record<string, unknown>);
                expect(events.length).toBe(1);
                expect(events[0]!.event).toBe('env_ignored_value');
                expect(events[0]!.name).toBe('TOKENS_USAGE_RAW_SAMPLE_RATE');
            });
        });
    });

    it('keeps raw sampling in the other modes', () => {
        for (const mode of ['raw', 'off']) {
            withEnv({ TOKENS_USAGE_LOG_MODE: mode, TOKENS_USAGE_RAW_SAMPLE_RATE: '0.5' }, () => {
                withCapturedWarnings(warnings => {
                    expect(loadEnv().usageRawSampleRate).toBe(0.5);
                    expect(warnings.length).toBe(0);
                });
            });
        }
    });

    it('stays silent in aggregated mode when sampling is not configured', () => {
        withEnv({ TOKENS_USAGE_LOG_MODE: 'aggregated' }, () => {
            withCapturedWarnings(warnings => {
                expect(loadEnv().usageRawSampleRate).toBe(0);
                expect(warnings.length).toBe(0);
            });
        });
    });

    it('never lets the usage hash TTL drop to a day or less', () => {
        withEnv({ TOKENS_USAGE_AGGREGATION_TTL_SECONDS: '60' }, () => {
            withCapturedWarnings(warnings => {
                expect(loadEnv().usageAggregationTtlSeconds).toBeGreaterThan(86_400);
                expect(warnings.length).toBe(1);
            });
        });
        withEnv({}, () => {
            expect(loadEnv().usageAggregationTtlSeconds).toBe(172_800);
        });
    });
});

describe('loadEnv cloudRun section', () => {
    const CLOUDRUN_VARS = {
        TOKENS_CLOUDRUN_AUTH_TOKEN: 'tok',
        TOKENS_CLOUDRUN_ASSETS_URL: 'https://assets.example.run.app',
        TOKENS_CLOUDRUN_PRICES_URL: 'https://prices.example.run.app',
        TOKENS_CLOUDRUN_USAGE_URL: 'https://usage.example.run.app',
    };

    it('is null when any required var is missing', () => {
        withEnv({ ...CLOUDRUN_VARS, TOKENS_CLOUDRUN_USAGE_URL: undefined }, () => {
            expect(loadEnv().cloudRun).toBeNull();
        });
    });

    it('resolves the full section including optional admin URL and timeout', () => {
        withEnv(
            { ...CLOUDRUN_VARS, TOKENS_CLOUDRUN_ADMIN_URL: 'https://admin.example.run.app', TOKENS_CLOUDRUN_TIMEOUT_MS: '20000' },
            () => {
                const cloudRun = loadEnv().cloudRun;
                expect(cloudRun).not.toBeNull();
                expect(cloudRun!.authToken).toBe('tok');
                expect(cloudRun!.urls.admin).toBe('https://admin.example.run.app');
                expect(cloudRun!.timeoutMs).toBe(20000);
            },
        );
    });
});
