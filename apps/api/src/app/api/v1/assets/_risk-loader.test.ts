import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';
import type { PegHealth, StructuralHealth } from '@tokens/asset-registry';

import { computeMarketScore } from '@/lib/token-risk-helpers';

mock.module('server-only', () => ({}));

const {
    loadAssetRisk,
    marketScoreInputFromVariantMarket,
    SOL_MINT,
    toRiskDetails,
    toRiskSummary,
    toStructuralHealthSummary,
} = await import('./_risk-loader');
const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
type AssetRiskPayload = import('./_risk-loader').AssetRiskPayload;

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = 1_800_000_000_000;

const pegHealth: PegHealth = {
    provider: 'webacy',
    tier: 'warning',
    overallRisk: 62.5,
    deviationPct: -2.4,
    priceUsd: 0.976,
    pegUsd: 1,
    liquidityUsd: null,
    tierSince: NOW - 60_000,
    updatedAt: NOW - 1_000,
    stale: false,
};

const structuralHealth: StructuralHealth = {
    provider: 'webacy',
    grade: 'B+',
    score: 31.2,
    categories: [
        { key: 'asset_collateral', label: 'Asset & collateral', score: 20, weight: 0.3, status: 'pass' },
        { key: 'market_liquidity', label: 'Market liquidity', score: 45, weight: 0.25, status: 'warn' },
        { key: 'smart_contract', label: 'Smart contract', score: 10, weight: 0.2, status: 'pass' },
        {
            key: 'operational_governance',
            label: 'Operations & governance',
            score: null,
            weight: 0.15,
            status: 'unknown',
        },
        { key: 'hack_exploit_history', label: 'Exploit history', score: 80, weight: 0.1, status: 'fail' },
    ],
    updatedAt: NOW - 5_000,
    stale: false,
};

function okPayload(mint: string, health: { pegHealth: PegHealth | null; structuralHealth: StructuralHealth | null }) {
    const marketScoreInput = marketScoreInputFromVariantMarket(mint, null);
    return {
        assetId: mint === SOL_MINT ? 'solana' : 'usd',
        mint,
        risk: {
            ok: true as const,
            marketScore: computeMarketScore(marketScoreInput),
            marketScoreInput,
            tags: [] as [],
            advisory: null,
            pegHealth: health.pegHealth,
            structuralHealth: health.structuralHealth,
            lastUpdatedAt: null,
        },
    } satisfies AssetRiskPayload;
}

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
        const payload = okPayload(SOL_MINT, { pegHealth: null, structuralHealth: null });

        const summary = toRiskSummary(payload);
        expect(summary.risk.ok).toBe(true);
        expect('marketScoreInput' in summary.risk).toBe(false);
        expect('advisory' in summary.risk).toBe(false);
        expect('marketScoreInput' in toRiskDetails(payload).risk).toBe(true);
    });

    it('carries null pegHealth/structuralHealth on both projections for unmonitored mints', () => {
        const payload = okPayload(SOL_MINT, { pegHealth: null, structuralHealth: null });

        const summary = toRiskSummary(payload);
        if (!summary.risk.ok) throw new Error('expected ok');
        expect('pegHealth' in summary.risk).toBe(true);
        expect('structuralHealth' in summary.risk).toBe(true);
        expect(summary.risk.pegHealth).toBeNull();
        expect(summary.risk.structuralHealth).toBeNull();

        const details = toRiskDetails(payload);
        if (!details.risk.ok) throw new Error('expected ok');
        expect(details.risk.pegHealth).toBeNull();
        expect(details.risk.structuralHealth).toBeNull();
    });

    it('summary keeps full pegHealth but reduces structuralHealth to the grade block', () => {
        const payload = okPayload(USDC, { pegHealth, structuralHealth });

        const summary = toRiskSummary(payload);
        if (!summary.risk.ok) throw new Error('expected ok');
        expect(summary.risk.pegHealth).toEqual(pegHealth);
        expect(summary.risk.structuralHealth).toEqual({
            provider: 'webacy',
            grade: 'B+',
            updatedAt: NOW - 5_000,
            stale: false,
        });
        expect('categories' in (summary.risk.structuralHealth as object)).toBe(false);
        expect('score' in (summary.risk.structuralHealth as object)).toBe(false);
    });

    it('details passes pegHealth and the full structuralHealth (categories + score) through', () => {
        const payload = okPayload(USDC, { pegHealth, structuralHealth });

        const details = toRiskDetails(payload);
        if (!details.risk.ok) throw new Error('expected ok');
        expect(details.risk.pegHealth).toEqual(pegHealth);
        expect(details.risk.structuralHealth).toEqual(structuralHealth);
        expect(details.risk.structuralHealth?.categories.length).toBe(5);
        expect(details.risk.structuralHealth?.score).toBe(31.2);
    });

    it('toStructuralHealthSummary maps null to null', () => {
        expect(toStructuralHealthSummary(null)).toBeNull();
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
    let healthCalls = 0;

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
        healthCalls = 0;
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
            if (url.includes('/query/stablecoinHealthGetByMints')) {
                healthCalls += 1;
                return json([
                    {
                        mint: JUP_MINT,
                        pegHealth: {
                            provider: 'tokens',
                            pegCurrency: 'USD',
                            referenceKind: 'fixed',
                            tier: 'watch',
                            overallRisk: null,
                            deviationPct: -0.7,
                            priceUsd: 0.993,
                            pegUsd: 1,
                            liquidityUsd: 2_500_000,
                            tierSince: SNAPSHOT_AT,
                            updatedAt: Date.now(),
                            ok: true,
                            errorMessage: null,
                        },
                        structuralHealth: null,
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

    function load(category: string = 'crypto') {
        const context = {
            selectedMint: JUP_MINT,
            assetDoc: { assetId: 'solana-jup', category },
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

    it('reads stablecoin health only for stablecoin-category assets', async () => {
        snapshot = DEEP;

        const crypto = await load('crypto');
        expect(healthCalls).toBe(0);
        if (!crypto.risk.ok) throw new Error('expected ok');
        expect(crypto.risk.pegHealth).toBeNull();
        expect(crypto.risk.structuralHealth).toBeNull();

        const stable = await load('stablecoin');
        expect(healthCalls).toBe(1);
        if (!stable.risk.ok) throw new Error('expected ok');
        expect(stable.risk.pegHealth?.provider).toBe('tokens');
        expect(stable.risk.pegHealth?.tier).toBe('watch');
        expect(stable.risk.pegHealth?.deviationPct).toBe(-0.7);
        expect(stable.risk.pegHealth?.stale).toBe(false);
        expect(stable.risk.structuralHealth).toBeNull();
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
