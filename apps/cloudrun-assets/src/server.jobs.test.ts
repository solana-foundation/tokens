import { describe, expect, it } from 'bun:test';

import type { AssetsRepo } from './handlers/assets';
import type { AssetDeletionTombstonesRepo } from './handlers/assetDeletionTombstones';
import type { SanctumLstsRepo } from './handlers/sanctumLsts';
import type { AssetMarketsRepo } from './handlers/assetMarkets';
import type { VariantMarketsRepo } from './handlers/variantMarkets';
import type { AssetVariantsRepo } from './handlers/assetVariants';
import type { AssetsApiRepo } from './handlers/assetsApi';
import type { CoingeckoReadsRepo } from './handlers/coingeckoReads';
import type { StockReadsRepo } from './handlers/stockReads';
import type { OhlcvReadsRepo } from './handlers/ohlcvReads';
import type { PrestocksReadsRepo } from './handlers/prestocksReads';
import type { TokensReadsRepo } from './handlers/tokensReads';
import type { TrendingReadsRepo } from './handlers/trendingReads';
import type { FillQualityReadsRepo } from './handlers/fillQualityReads';
import type { AssetCollectionsReadsRepo } from './handlers/assetCollectionsReads';
import type { TokenListsReadsRepo } from './handlers/tokenListsReads';
import type { TokenListsMutationsDeps } from './handlers/tokenListsMutations';
import type { CronDeps } from './handlers/crons';
import { OidcAuthError, type VerifyOidc } from './oidc';
import { createApp } from './server';

const noopDeletionTombstonesRepo: AssetDeletionTombstonesRepo = {
    async findDeletedNormalizedRefs() { return []; },
};
const noopSanctumLstsRepo: SanctumLstsRepo = {
    async listActive() { return []; },
    async findByMint() { return null; },
    async findActiveBySymbolLower() { return []; },
};
const noopAssetMarketsRepo: AssetMarketsRepo = {
    async findLatestByAssetId() { return null; },
    async findLatestByAssetIds() { return []; },
};
const noopVariantMarketsRepo: VariantMarketsRepo = {
    async findLatestByMints() { return []; },
};
const noopAssetVariantsRepo: AssetVariantsRepo = {
    async findVariantByMint() { return null; },
    async findVariantsByMints() { return []; },
    async findVariantsByAssetIds() { return []; },
    async findActiveSolanaVariants() { return []; },
    async findAssetIsActive() { return null; },
    async findSolanaDefaultVariantsView() { return null; },
    async upsertSolanaDefaultVariantsView() {},
    async findVariantMarketsByMints() { return []; },
    async findTokenMarketsByMints() { return []; },
};
const noopAssetsApiRepo: AssetsApiRepo = {
    async findAssetByAssetId() { return null; },
    async findActiveVariantsByAssetId() { return []; },
    async findVariantMarketsLatestByMint() { return null; },
    async findVariantMarketsLatestByMints() { return []; },
    async findVariantFillQualityLatestByMint() { return null; },
    async findVariantFillQualityLatestByMints() { return []; },
    async findAssetMarketsLatestByAssetId() { return null; },
    async findCoingeckoCoinByCoinId() { return null; },
    async findStockInstrumentsLatestByAssetId() { return null; },
    async findStockPricesLatestByAssetId() { return null; },
};
const noopCoingeckoReadsRepo: CoingeckoReadsRepo = {
    async findCoinByCoinId() { return null; },
    async searchCoinsById() { return []; },
    async searchCoinsBySymbol() { return []; },
    async searchCoinsByName() { return []; },
    async listOhlcv() { return []; },
    async findPriceLatestByCoinId() { return null; },
    async findPriceLatestByCoinIds() { return []; },
    async findTickersLatestByCoinId() { return null; },
};
const noopStockReadsRepo: StockReadsRepo = {
    async findInstrumentByAssetId() { return null; },
    async findInstrumentsByAssetIds() { return []; },
    async findPriceByAssetId() { return null; },
    async findPricesByAssetIds() { return []; },
};
const noopOhlcvReadsRepo: OhlcvReadsRepo = {
    async listByAddressAndInterval() { return []; },
    async getBoundsByAddressAndInterval() { return { minTime: null, maxTime: null }; },
    async listByAssetIdAndInterval() { return []; },
};
const noopPrestocksReadsRepo: PrestocksReadsRepo = {
    async findLatestByMints() { return []; },
};
const noopTokensReadsRepo: TokensReadsRepo = {
    async findTokenByAddress() { return null; },
    async findTokensByAddresses() { return []; },
    async searchTokensBySymbol() { return []; },
    async searchTokensByName() { return []; },
    async findTokenMarketsLatestByMint() { return null; },
    async findTokenMarketsLatestByMints() { return []; },
    async findTokenDescriptionSummaryByAddress() { return null; },
};
const noopTrendingReadsRepo: TrendingReadsRepo = {
    async listTrending() { return []; },
    async listFreshTrending() { return []; },
};
const noopFillQualityReadsRepo: FillQualityReadsRepo = {
    async findLatestByMints() { return []; },
};
const noopTokenListsReadsRepo: TokenListsReadsRepo = {
    async listPublished() { return []; },
    async getBySlug() { return null; },
    async listMembersBySlug() { return []; },
    async listSlugsByMints() { return []; },
};
const noopTokenListsMutationsDeps: TokenListsMutationsDeps = {
    repo: {
        async getListBySlug() { return null; },
        async insertList() { throw new Error('not implemented'); },
        async updateList() { throw new Error('not implemented'); },
        async deleteList() { throw new Error('not implemented'); },
        async upsertMember() {},
        async removeMember() { return false; },
        async hasActiveVariantForMint() { return false; },
        async hasTokenForAddress() { return false; },
    },
    fetchTokenOverview: async () => null,
    now: () => 0,
};
const noopAssetCollectionsReadsRepo: AssetCollectionsReadsRepo = {
    async listMembersBySlug() { return []; },
    async listMemberMintsBySlug() { return []; },
    async getSummariesBySlugs() { return []; },
};
const baseDeps = {
    repo: undefined as unknown as AssetsRepo,
    assetsApiRepo: noopAssetsApiRepo,
    deletionTombstonesRepo: noopDeletionTombstonesRepo,
    sanctumLstsRepo: noopSanctumLstsRepo,
    assetMarketsRepo: noopAssetMarketsRepo,
    variantMarketsRepo: noopVariantMarketsRepo,
    assetVariantsRepo: noopAssetVariantsRepo,
    coingeckoReadsRepo: noopCoingeckoReadsRepo,
    stockReadsRepo: noopStockReadsRepo,
    ohlcvReadsRepo: noopOhlcvReadsRepo,
    prestocksReadsRepo: noopPrestocksReadsRepo,
    tokensReadsRepo: noopTokensReadsRepo,
    trendingReadsRepo: noopTrendingReadsRepo,
    fillQualityReadsRepo: noopFillQualityReadsRepo,
    assetCollectionsReadsRepo: noopAssetCollectionsReadsRepo,
    tokenListsReadsRepo: noopTokenListsReadsRepo,
    tokenListsMutationsDeps: noopTokenListsMutationsDeps,
};

const noopRepo: AssetsRepo = {
    async findByAssetId() {
        return null;
    },
    async findByAssetIds() {
        return [];
    },
    async findAliasesByNormalized() {
        return [];
    },
    async findAliasesByFuzzy() {
        return [];
    },
    async findAssetsByNameFuzzy() {
        return [];
    },
    async findAssetsBySymbolFuzzy() {
        return [];
    },
    async findVariantByMint() {
        return null;
    },
    async isDeletedRef() {
        return false;
    },
    async listByCategory() {
        return [];
    },
    async listActiveWithCoinGecko() {
        return [];
    },
    async setDescriptionByAssetId() {
        return false;
    },
};

const allowOidc: VerifyOidc = async () => ({
    sub: '1',
    email: 'cron@example.iam.gserviceaccount.com',
    aud: 'https://assets.example.run.app',
    iss: 'https://accounts.google.com',
});

const denyOidc: VerifyOidc = async () => {
    throw new OidcAuthError('bad');
};

function emptyCronDeps(): CronDeps {
    return {
        repo: {
            async upsertVariantMarketFromBirdeye() {},
            async touchVariantMarket() {},
            async getOverviewLastFetchedAtByMint() { return null; },
            async listStaleVariantMints() { return []; },
            async listCuratedAssetIds() { return []; },
            async listVariantsForRollup() { return []; },
            async listVariantLastComputedByAssetIds() { return new Map(); },
            async sumDailyOhlcvVolumeByAddresses() { return new Map(); },
            async upsertAssetAggregate() {},
            async listActiveSanctumLstCount() { return 0; },
            async listSanctumSourceRanks() { return new Map(); },
            async upsertSanctumLstLatest() {},
            async deactivateMissingSanctumLsts() { return 0; },
            async findVariantByMint() { return null; },
            async getAssetRiskLastFetchedAtByMint() { return null; },
            async upsertAssetRiskLatest() {},
            async findVariantMarketForRiskByMint() { return null; },
            async upsertWebacyTokenLatest() {},
            async upsertWebacyTradingLiteLatest() {},
            async upsertWebacyHolderAnalysisLatest() {},
            async findRwaXyzAssetLatestByAssetId() { return null; },
            async findRwaXyzTokenLatestByNetworkAndAddress() { return null; },
            async upsertRwaXyzAssetLatest() {},
            async upsertRwaXyzTokenLatest() {},
            async listRecentActiveProjects() { return []; },
            async getRollupStateForProject() { return null; },
            async tryAcquireRollupLock() { return true; },
            async releaseRollupLock() {},
            async listProjectEventsForRollup() { return []; },
            async applyDailyRollupDelta() {},
            async applyEndpointDailyRollupDelta() {},
            async listAllProjectIds() { return []; },
            async pruneApiRequestEventsForProject() { return 0; },
            async getOhlcvBounds() { return { minTime: null, maxTime: null }; },
            async upsertOhlcvCandles() { return { inserted: 0, updated: 0, skipped: 0 }; },
            async applyRollupBatchAtomic() { return true; },
        },
        curated: {
            getAllCuratedMintsInOrder: () => [],
            getCuratedMintRank: () => new Map(),
        },
        birdeye: { async fetchTokenOverview() { return null; } },
        birdeyeOhlcv: { async fetchOhlcv() { return []; } },
        sanctum: { async fetchAndNormalizeLsts() { return { ok: false, reason: 'missing_env' as const }; } },
        webacy: {
            isConfigured: () => true,
            async fetchAll() {
                return {
                    token: { ok: false, status: 0, message: 'n/a' },
                    trading: { ok: false, status: 0, message: 'n/a' },
                    holder: { ok: false, status: 0, message: 'n/a' },
                };
            },
        },
        now: () => 1_780_000_000_000,
    };
}

async function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
    return app.fetch(new Request(`http://test${path}`, init));
}

describe('POST /jobs/:name', () => {
    it('returns 404 clickhouse_jobs_disabled for clickhouse jobs when those deps are missing', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: allowOidc,
        });
        const res = await call(app, '/jobs/refresh-solana-clickhouse-trade-snapshots', {
            method: 'POST',
            headers: { authorization: 'Bearer x' },
            body: '{}',
        });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe('clickhouse_jobs_disabled');
    });

    it('returns 404 jobs_disabled when cronDeps is missing', async () => {
        const app = createApp({ ...baseDeps, repo: noopRepo, authToken: 'tok' });
        const res = await call(app, '/jobs/sync-sanctum-lsts', {
            method: 'POST',
            headers: { authorization: 'Bearer x' },
            body: '{}',
        });
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: string }).error).toBe('jobs_disabled');
    });

    it('returns 401 when no bearer is present', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: allowOidc,
        });
        const res = await call(app, '/jobs/sync-sanctum-lsts', { method: 'POST', body: '{}' });
        expect(res.status).toBe(401);
    });

    it('returns 401 when OIDC verification fails', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: denyOidc,
        });
        const res = await call(app, '/jobs/sync-sanctum-lsts', {
            method: 'POST',
            headers: { authorization: 'Bearer not-a-valid-jwt' },
            body: '{}',
        });
        expect(res.status).toBe(401);
    });

    it('rejects bearer-shared-secret tokens (OIDC required)', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: denyOidc,
        });
        const res = await call(app, '/jobs/sync-sanctum-lsts', {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: '{}',
        });
        expect(res.status).toBe(401);
    });

    it('returns 404 for unknown job name', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: allowOidc,
        });
        const res = await call(app, '/jobs/does-not-exist', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt' },
            body: '{}',
        });
        expect(res.status).toBe(404);
    });

    it('returns 404 for prototype-method job names', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: allowOidc,
        });
        for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            const res = await call(app, `/jobs/${name}`, {
                method: 'POST',
                headers: { authorization: 'Bearer jwt' },
                body: '{}',
            });
            expect(res.status).toBe(404);
        }
    });

    it('runs a known job after OIDC passes', async () => {
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: emptyCronDeps(),
            verifyOidc: allowOidc,
        });
        const res = await call(app, '/jobs/sync-sanctum-lsts', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(200);
        const payload = (await res.json()) as { ok: boolean; skipped?: boolean; reason?: string };
        expect(payload.ok).toBe(true);
        expect(payload.skipped).toBe(true);
        expect(payload.reason).toBe('missing_env');
    });

    it('returns 500 hiding handler errors', async () => {
        const deps = emptyCronDeps();
        deps.sanctum = {
            async fetchAndNormalizeLsts() {
                throw new Error('internal db host secret');
            },
        };
        const app = createApp({
            ...baseDeps, repo: noopRepo,
            authToken: 'tok',
            cronDeps: deps,
            verifyOidc: allowOidc,
        });
        const res = await call(app, '/jobs/sync-sanctum-lsts', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(500);
        const payload = (await res.json()) as { error: string; message?: string };
        expect(payload.error).toBe('handler_error');
        expect(payload.message).toBeUndefined();
    });
});
