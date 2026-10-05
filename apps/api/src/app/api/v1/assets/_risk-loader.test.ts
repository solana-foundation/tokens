import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

import { computeMarketScore } from '@/lib/token-risk-helpers';

mock.module('server-only', () => ({}));

const { loadAssetRisk, marketScoreInputFromVariantMarket, SOL_MINT, toRiskDetails, toRiskSummary } =
    await import('./_risk-loader');
const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
type AssetRiskPayload = import('./_risk-loader').AssetRiskPayload;

describe('risk loader helpers', () => {
    it('builds empty SOL market score input', () => {
        const input = marketScoreInputFromVariantMarket(SOL_MINT, null);
        expect(input.liquidityUsd).toBe(null);
        expect(input.marketCapUsd).toBe(null);
        expect(input.holderCount).toBe(null);
        expect(input.tokenAddress).toBe(SOL_MINT);
    });

    it('keeps non-SOL no-market as not_found payload shape', () => {
        const payload: AssetRiskPayload = {
            assetId: 'asset',
            mint: 'mint',
            risk: { ok: false, reason: 'not_found', message: 'Market snapshot not available in cache' },
        };
        expect(toRiskSummary(payload)).toBe(payload);
        expect(toRiskDetails(payload)).toBe(payload);
    });

    it('omits details-only fields from summary projection', () => {
        const marketScoreInput = marketScoreInputFromVariantMarket(SOL_MINT, null);
        const payload: AssetRiskPayload = {
            assetId: 'solana',
            mint: SOL_MINT,
            risk: {
                ok: true,
                marketScore: computeMarketScore(marketScoreInput),
                marketScoreInput,
                tags: [],
                advisory: null,
                lastUpdatedAt: null,
            },
        };

        const summary = toRiskSummary(payload);
        expect(summary.risk.ok).toBe(true);
        expect('marketScoreInput' in summary.risk).toBe(false);
        expect('advisory' in summary.risk).toBe(false);
        expect('marketScoreInput' in toRiskDetails(payload).risk).toBe(true);
    });
});

describe('loadAssetRisk', () => {
    const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const AUTH = {
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes: ['assets:read'],
    };
    const SNAPSHOT_AT = 1_790_000_000_000;

    const ENV_KEYS = [
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
        'TOKENS_REDIS_TARGET',
        'TOKENS_CLOUDRUN_AUTH_TOKEN',
        'TOKENS_CLOUDRUN_ASSETS_URL',
        'TOKENS_CLOUDRUN_PRICES_URL',
        'TOKENS_CLOUDRUN_USAGE_URL',
        'TOKENS_CACHE_WARM_SECRET',
        'BIRDEYE_API_KEY',
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    const ORIGINAL_FETCH = globalThis.fetch;
    const ORIGINAL_LOG = console.log;
    const ORIGINAL_ERROR = console.error;

    type Market = {
        liquidity: number | null;
        marketCap: number | null;
        holder: number | null;
        volume24hUSD: number | null;
    };
    let snapshot: Market | null = null;
    let overview: (() => Response) | null = null;
    let overviewCalls = 0;

    function json(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }

    beforeEach(() => {
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
        process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
        process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
        process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
        process.env.BIRDEYE_API_KEY = 'test-key';
        resetEnvForTests();
        __resetCloudRunClientForTesting();

        snapshot = null;
        overview = null;
        overviewCalls = 0;
        globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('/query/variantMarketsGetLatestByMints')) {
                return json([
                    {
                        mint: JUP_MINT,
                        assetId: null,
                        chain: null,
                        market: snapshot && {
                            mint: JUP_MINT,
                            source: 'birdeye',
                            lastFetchedAt: SNAPSHOT_AT,
                            ...snapshot,
                        },
                        executionQuality: null,
                        advisory: null,
                    },
                ]);
            }
            if (url.includes('/query/curatedMembershipGetSnapshot')) {
                return json({ loadedAt: Date.now(), mintsByList: {}, allMints: [], entriesByMint: {} });
            }
            if (url.startsWith('https://public-api.birdeye.so/defi/token_overview')) {
                overviewCalls += 1;
                if (overview) return overview();
            }
            throw new Error(`unexpected fetch: ${url}`);
        }) as typeof fetch;
        console.log = () => undefined;
        console.error = () => undefined;
    });

    afterEach(() => {
        globalThis.fetch = ORIGINAL_FETCH;
        console.log = ORIGINAL_LOG;
        console.error = ORIGINAL_ERROR;
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        resetEnvForTests();
        __resetCloudRunClientForTesting();
    });

    function load() {
        const context = {
            selectedMint: JUP_MINT,
            assetDoc: { assetId: 'solana-jup' },
            selectedVariant: {},
            advisoriesByMint: new Map(),
        } as unknown as Parameters<typeof loadAssetRisk>[0];
        return Effect.runPromise(loadAssetRisk(context, { operation: 'details', auth: AUTH }));
    }

    const DEEP: Market = { liquidity: 12_000_000, marketCap: 900_000_000, holder: 400_000, volume24hUSD: 9_000_000 };

    it('scores from the snapshot without a live read', async () => {
        snapshot = DEEP;
        const payload = await load();

        expect(payload.risk.ok).toBe(true);
        if (!payload.risk.ok) return;
        expect(payload.risk.marketScore.grade).toBe('A');
        expect(payload.risk.lastUpdatedAt).toBe(SNAPSHOT_AT);
        expect(overviewCalls).toBe(0);
    });

    it('scores from a live read when there is no snapshot', async () => {
        overview = () => json({ success: true, data: { ...DEEP, v24hUSD: DEEP.volume24hUSD } });
        const before = Date.now();
        const payload = await load();

        expect(payload.risk.ok).toBe(true);
        if (!payload.risk.ok) return;
        expect(payload.risk.marketScore.grade).toBe('A');
        expect(payload.risk.marketScore.hasInsufficientData).toBe(false);
        expect(payload.risk.marketScoreInput.liquidityUsd).toBe(DEEP.liquidity);
        expect(payload.risk.marketScoreInput.holderCount).toBe(DEEP.holder);
        expect(payload.risk.lastUpdatedAt).toBeGreaterThanOrEqual(before);
    });

    it('stays not_found when neither a snapshot nor live data exists', async () => {
        for (const respond of [() => json({ success: true, data: {} }), () => json({ success: false }, 500)]) {
            overview = respond;
            const payload = await load();
            expect(payload.risk).toEqual({
                ok: false,
                reason: 'not_found',
                message: 'Market snapshot not available in cache',
            });
        }
    });
});
