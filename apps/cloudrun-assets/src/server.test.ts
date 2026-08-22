import { describe, expect, it } from 'bun:test';

import type { AssetAliasRow, AssetRow, AssetVariantRow, AssetsRepo, CallerIdentity } from './handlers/assets';
import type { AssetDeletionTombstonesRepo } from './handlers/assetDeletionTombstones';
import type { SanctumLstRow, SanctumLstsRepo } from './handlers/sanctumLsts';
import type { AssetMarketRow, AssetMarketsRepo } from './handlers/assetMarkets';
import type { VariantMarketRow, VariantMarketsRepo } from './handlers/variantMarkets';
import type { AssetVariantDocRow, AssetVariantsRepo } from './handlers/assetVariants';
import type {
    CoingeckoCoinRow,
    CoingeckoCoinSearchRow,
    CoingeckoOhlcvRow,
    CoingeckoPriceLatestRow,
    CoingeckoReadsRepo,
    CoingeckoTickersLatestRow,
} from './handlers/coingeckoReads';
import type { StockInstrumentRow, StockPriceRow, StockReadsRepo } from './handlers/stockReads';
import type { OhlcvCandleRow, OhlcvReadsRepo } from './handlers/ohlcvReads';
import type { PrestocksReadsRepo } from './handlers/prestocksReads';
import type {
    AssetsApiAssetMarketRow,
    AssetsApiAssetRow,
    AssetsApiCoingeckoCoinRow,
    AssetsApiFillQualityRow,
    AssetsApiRepo,
    AssetsApiStockInstrumentRow,
    AssetsApiStockPriceRow,
    AssetsApiVariantMarketRow,
    AssetsApiVariantRow,
} from './handlers/assetsApi';
import type {
    TokenRow,
    TokenMarketsLatestRow,
    TokenDescriptionSummaryRow,
    TokensReadsRepo,
} from './handlers/tokensReads';
import type { TrendingMarketRow, FreshTrendingMarketRow, TrendingReadsRepo } from './handlers/trendingReads';
import type { FillQualityRow, FillQualityReadsRepo } from './handlers/fillQualityReads';
import type { AssetCollectionMemberRow, AssetCollectionsReadsRepo } from './handlers/assetCollectionsReads';
import type { TokenListsReadsRepo } from './handlers/tokenListsReads';
import type { TokenListsMutationsDeps } from './handlers/tokenListsMutations';
import type { CacheWarmDeps } from './handlers/cacheWarm';
import type { AdminActionsDeps, AdminActionsRepo } from './handlers/adminActions';
import { createApp, type ServerDeps } from './server';

const NOW = new Date('2026-06-01T00:00:00Z');

const sampleRow = (overrides: Partial<AssetRow> = {}): AssetRow => ({
    id: 'jr1',
    asset_id: 'jup',
    category: 'crypto',
    name: 'Jupiter',
    symbol: 'JUP',
    aliases: ['JUP'],
    coingecko_id: 'jupiter-exchange-solana',
    description: null,
    image_url: 'https://example.test/jup.png',
    is_active: true,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
});

interface MockRepoData {
    byAssetId?: Record<string, AssetRow>;
    aliasesByNormalized?: Record<string, AssetAliasRow[]>;
    aliasesFuzzy?: Record<string, AssetAliasRow[]>;
    assetsNameFuzzy?: Record<string, AssetRow[]>;
    assetsSymbolFuzzy?: Record<string, AssetRow[]>;
    variantsByMint?: Record<string, AssetVariantRow>;
    deletedRefs?: ReadonlySet<string>;
    byCategory?: {
        category: string;
        includeInactive: boolean;
        rows: AssetRow[];
    }[];
    activeWithCoinGecko?: AssetRow[];
    descriptionCalls?: {
        assetId: string;
        description: string | null;
        updatedAt: Date;
    }[];
}

function makeRepo(data: MockRepoData = {}): AssetsRepo {
    return {
        async findByAssetId(assetId) {
            return data.byAssetId?.[assetId] ?? null;
        },
        async findByAssetIds(assetIds) {
            const out: AssetRow[] = [];
            for (const id of assetIds) {
                const row = data.byAssetId?.[id];
                if (row) out.push(row);
            }
            return out;
        },
        async findAliasesByNormalized(normalized, limit) {
            const all = data.aliasesByNormalized?.[normalized] ?? [];
            return all.slice(0, limit);
        },
        async findAliasesByFuzzy(query, limit) {
            const all = data.aliasesFuzzy?.[query] ?? [];
            return all.slice(0, limit);
        },
        async findAssetsByNameFuzzy(query, limit) {
            const all = data.assetsNameFuzzy?.[query] ?? [];
            return all.slice(0, limit);
        },
        async findAssetsBySymbolFuzzy(query, limit) {
            const all = data.assetsSymbolFuzzy?.[query] ?? [];
            return all.slice(0, limit);
        },
        async findVariantByMint(mint) {
            return data.variantsByMint?.[mint] ?? null;
        },
        async isDeletedRef(normalizedRef) {
            return data.deletedRefs?.has(normalizedRef) ?? false;
        },
        async listByCategory(category, includeInactive, limit) {
            const match = data.byCategory?.find(e => e.category === category && e.includeInactive === includeInactive);
            if (!match) return [];
            return match.rows.slice(0, limit);
        },
        async listActiveWithCoinGecko(limit) {
            return (data.activeWithCoinGecko ?? []).slice(0, limit);
        },
        async setDescriptionByAssetId(assetId, description, updatedAt) {
            data.descriptionCalls?.push({ assetId, description, updatedAt });
            return data.byAssetId?.[assetId] !== undefined;
        },
    };
}

function emptyDeletionTombstonesRepo(): AssetDeletionTombstonesRepo {
    return {
        async findDeletedNormalizedRefs() {
            return [];
        },
    };
}

function emptySanctumLstsRepo(): SanctumLstsRepo {
    return {
        async listActive() {
            return [];
        },
        async findByMint() {
            return null;
        },
        async findActiveBySymbolLower() {
            return [];
        },
    };
}

function emptyAssetMarketsRepo(): AssetMarketsRepo {
    return {
        async findLatestByAssetId() {
            return null;
        },
        async findLatestByAssetIds() {
            return [];
        },
    };
}

function emptyVariantMarketsRepo(): VariantMarketsRepo {
    return {
        async findLatestByMints() {
            return [];
        },
    };
}

function emptyAssetVariantsRepo(): AssetVariantsRepo {
    return {
        async findVariantByMint() {
            return null;
        },
        async findVariantsByMints() {
            return [];
        },
        async findVariantsByAssetIds() {
            return [];
        },
        async findActiveSolanaVariants() {
            return [];
        },
        async findAssetIsActive() {
            return null;
        },
        async findSolanaDefaultVariantsView() {
            return null;
        },
        async upsertSolanaDefaultVariantsView() {},
        async findVariantMarketsByMints() {
            return [];
        },
        async findTokenMarketsByMints() {
            return [];
        },
    };
}

function emptyStockReadsRepo(): StockReadsRepo {
    return {
        async findInstrumentByAssetId() {
            return null;
        },
        async findInstrumentsByAssetIds() {
            return [];
        },
        async findPriceByAssetId() {
            return null;
        },
        async findPricesByAssetIds() {
            return [];
        },
    };
}

function emptyPrestocksReadsRepo(): PrestocksReadsRepo {
    return {
        async findLatestByMints() {
            return [];
        },
    };
}

function emptyOhlcvReadsRepo(): OhlcvReadsRepo {
    return {
        async listByAddressAndInterval() {
            return [];
        },
        async getBoundsByAddressAndInterval() {
            return { minTime: null, maxTime: null };
        },
        async listByAssetIdAndInterval() {
            return [];
        },
    };
}

interface AssetsApiRepoData {
    assetsByAssetId?: Record<string, AssetsApiAssetRow>;
    activeVariantsByAssetId?: Record<string, AssetsApiVariantRow[]>;
    variantMarketsByMint?: Record<string, AssetsApiVariantMarketRow>;
    fillQualityByMint?: Record<string, AssetsApiFillQualityRow>;
    assetMarketByAssetId?: Record<string, AssetsApiAssetMarketRow>;
    coingeckoCoinByCoinId?: Record<string, AssetsApiCoingeckoCoinRow>;
    stockInstrumentByAssetId?: Record<string, AssetsApiStockInstrumentRow>;
    stockPriceByAssetId?: Record<string, AssetsApiStockPriceRow>;
}

function makeAssetsApiRepo(data: AssetsApiRepoData = {}): AssetsApiRepo {
    return {
        async findAssetByAssetId(assetId) {
            return data.assetsByAssetId?.[assetId] ?? null;
        },
        async findActiveVariantsByAssetId(assetId) {
            return data.activeVariantsByAssetId?.[assetId] ?? [];
        },
        async findVariantMarketsLatestByMint(mint) {
            return data.variantMarketsByMint?.[mint] ?? null;
        },
        async findVariantMarketsLatestByMints(mints) {
            const map = data.variantMarketsByMint ?? {};
            const out: AssetsApiVariantMarketRow[] = [];
            for (const mint of mints) {
                const row = map[mint];
                if (row) out.push(row);
            }
            return out;
        },
        async findVariantFillQualityLatestByMint(mint) {
            return data.fillQualityByMint?.[mint] ?? null;
        },
        async findVariantFillQualityLatestByMints(mints) {
            const map = data.fillQualityByMint ?? {};
            const out: AssetsApiFillQualityRow[] = [];
            for (const mint of mints) {
                const row = map[mint];
                if (row) out.push(row);
            }
            return out;
        },
        async findAssetMarketsLatestByAssetId(assetId) {
            return data.assetMarketByAssetId?.[assetId] ?? null;
        },
        async findCoingeckoCoinByCoinId(coinId) {
            return data.coingeckoCoinByCoinId?.[coinId] ?? null;
        },
        async findStockInstrumentsLatestByAssetId(assetId) {
            return data.stockInstrumentByAssetId?.[assetId] ?? null;
        },
        async findStockPricesLatestByAssetId(assetId) {
            return data.stockPriceByAssetId?.[assetId] ?? null;
        },
    };
}

const noopAssetsApiRepo: AssetsApiRepo = makeAssetsApiRepo();

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
    return {
        repo: overrides.repo ?? makeRepo(),
        assetsApiRepo: overrides.assetsApiRepo ?? noopAssetsApiRepo,
        deletionTombstonesRepo: overrides.deletionTombstonesRepo ?? emptyDeletionTombstonesRepo(),
        sanctumLstsRepo: overrides.sanctumLstsRepo ?? emptySanctumLstsRepo(),
        assetMarketsRepo: overrides.assetMarketsRepo ?? emptyAssetMarketsRepo(),
        variantMarketsRepo: overrides.variantMarketsRepo ?? emptyVariantMarketsRepo(),
        assetVariantsRepo: overrides.assetVariantsRepo ?? emptyAssetVariantsRepo(),
        coingeckoReadsRepo: overrides.coingeckoReadsRepo ?? emptyCoingeckoReadsRepo(),
        stockReadsRepo: overrides.stockReadsRepo ?? emptyStockReadsRepo(),
        ohlcvReadsRepo: overrides.ohlcvReadsRepo ?? emptyOhlcvReadsRepo(),
        prestocksReadsRepo: overrides.prestocksReadsRepo ?? emptyPrestocksReadsRepo(),
        tokensReadsRepo: overrides.tokensReadsRepo ?? emptyTokensReadsRepo(),
        trendingReadsRepo: overrides.trendingReadsRepo ?? emptyTrendingReadsRepo(),
        fillQualityReadsRepo: overrides.fillQualityReadsRepo ?? emptyFillQualityReadsRepo(),
        assetCollectionsReadsRepo: overrides.assetCollectionsReadsRepo ?? emptyAssetCollectionsReadsRepo(),
        tokenListsReadsRepo: overrides.tokenListsReadsRepo ?? emptyTokenListsReadsRepo(),
        tokenListsMutationsDeps: overrides.tokenListsMutationsDeps ?? emptyTokenListsMutationsDeps(),
        authToken: overrides.authToken ?? 'tok',
        ...(overrides.serviceRole ? { serviceRole: overrides.serviceRole } : {}),
        ...(overrides.checkDatabase ? { checkDatabase: overrides.checkDatabase } : {}),
        ...(overrides.cronDeps ? { cronDeps: overrides.cronDeps } : {}),
        ...(overrides.verifyOidc ? { verifyOidc: overrides.verifyOidc } : {}),
        ...(overrides.cacheWarmDeps ? { cacheWarmDeps: overrides.cacheWarmDeps } : {}),
        ...(overrides.adminActionsDeps ? { adminActionsDeps: overrides.adminActionsDeps } : {}),
    };
}

function encodeIdentity(identity: CallerIdentity): string {
    return Buffer.from(JSON.stringify(identity), 'utf8').toString('base64');
}

async function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
    return app.fetch(new Request(`http://test${path}`, init));
}

function authed(body: unknown): RequestInit {
    return {
        method: 'POST',
        headers: {
            authorization: 'Bearer tok',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    };
}

describe('createApp - infrastructure', () => {
    it('GET /health returns 200', async () => {
        const app = createApp(deps());
        const res = await call(app, '/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('GET /startup gates traffic on a database check without changing /health', async () => {
        let available = false;
        const app = createApp(
            deps({
                checkDatabase: async () => {
                    if (!available)
                        throw Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' });
                },
            }),
        );
        expect((await call(app, '/health')).status).toBe(200);
        expect((await call(app, '/startup')).status).toBe(503);
        available = true;
        expect((await call(app, '/startup')).status).toBe(200);
    });

    it('GET /startup returns 503 when the database check does not settle before its timeout', async () => {
        const app = createApp(
            deps({
                checkDatabase: () => new Promise<void>(() => {}),
                startupDatabaseTimeoutMs: 5,
            }),
        );

        const response = await call(app, '/startup');
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false });
    });

    it('isolates API and worker route surfaces', async () => {
        const worker = createApp(deps({ serviceRole: 'worker' }));
        expect((await call(worker, '/query/getByAssetId', authed({ assetId: 'jup' }))).status).toBe(404);

        const api = createApp(deps({ serviceRole: 'api' }));
        expect((await call(api, '/jobs/anything', { method: 'POST' })).status).toBe(404);
    });

    it('keeps worker job routes behind OIDC authentication', async () => {
        const verifiedTokens: string[] = [];
        const worker = createApp(
            deps({
                serviceRole: 'worker',
                cronDeps: {} as NonNullable<ServerDeps['cronDeps']>,
                verifyOidc: async token => {
                    verifiedTokens.push(token);
                    return {
                        sub: 'scheduler',
                        email: 'scheduler@example.test',
                        aud: 'worker-url',
                        iss: 'https://accounts.google.com',
                    };
                },
            }),
        );

        expect((await call(worker, '/jobs/not-a-real-job', { method: 'POST' })).status).toBe(401);
        const response = await call(worker, '/jobs/not-a-real-job', {
            method: 'POST',
            headers: {
                authorization: 'Bearer scheduler-oidc-token',
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(response.status).toBe(404);
        expect(verifiedTokens).toEqual(['scheduler-oidc-token']);
    });

    it('POST /query/<name> rejects missing/wrong bearer with 401', async () => {
        const app = createApp(deps());
        const noAuth = await call(app, '/query/getByAssetId', {
            method: 'POST',
            body: '{}',
        });
        expect(noAuth.status).toBe(401);
        const wrongAuth = await call(app, '/query/getByAssetId', {
            method: 'POST',
            headers: { authorization: 'Bearer nope' },
            body: '{}',
        });
        expect(wrongAuth.status).toBe(401);
    });

    it('POST /query/<unknown> returns 404', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/doesNotExist', {
            method: 'POST',
            headers: { authorization: 'Bearer tok' },
            body: '{}',
        });
        expect(res.status).toBe(404);
    });

    it('POST /query/<prototype-method> returns 404', async () => {
        const app = createApp(deps());
        for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
            const res = await call(app, `/query/${name}`, {
                method: 'POST',
                headers: { authorization: 'Bearer tok' },
                body: '{}',
            });
            expect(res.status).toBe(404);
        }
    });

    it('retries a query once when the pool socket died mid-flight', async () => {
        let calls = 0;
        const flakyRepo: AssetsRepo = {
            ...makeRepo({ byAssetId: { jup: sampleRow() } }),
            findByAssetId: async assetId => {
                calls += 1;
                if (calls === 1) {
                    const err = new Error('write CONNECTION_CLOSED 172.20.2.3:5432') as Error & { code: string };
                    err.code = 'CONNECTION_CLOSED';
                    throw err;
                }
                return makeRepo({
                    byAssetId: { jup: sampleRow() },
                }).findByAssetId(assetId);
            },
        };
        const app = createApp(deps({ repo: flakyRepo }));
        const res = await call(app, '/query/getByAssetId', authed({ assetId: 'jup' }));
        expect(res.status).toBe(200);
        expect(calls).toBe(2);
    });

    it('does not retry when the dead connection persists', async () => {
        let calls = 0;
        const deadRepo: AssetsRepo = {
            ...makeRepo(),
            findByAssetId: async () => {
                calls += 1;
                const err = new Error('write CONNECTION_CLOSED 172.20.2.3:5432') as Error & { code: string };
                err.code = 'CONNECTION_CLOSED';
                throw err;
            },
        };
        const app = createApp(deps({ repo: deadRepo }));
        const res = await call(app, '/query/getByAssetId', authed({ assetId: 'jup' }));
        expect(res.status).toBe(500);
        expect(calls).toBe(2);
    });

    it('does not replay a composite query after a transient database failure', async () => {
        let calls = 0;
        const failingCollections: AssetCollectionsReadsRepo = {
            ...emptyAssetCollectionsReadsRepo(),
            listMembersBySlug: async () => {
                calls += 1;
                throw Object.assign(new Error('write CONNECT_TIMEOUT 172.20.2.3:5432'), { code: 'CONNECT_TIMEOUT' });
            },
        };
        const app = createApp(deps({ assetCollectionsReadsRepo: failingCollections }));
        const res = await call(
            app,
            '/query/assetsApiCuratedPrefetchForApi',
            authed({
                listId: 'majors',
                memberMints: [],
                memberAssetIds: [],
            }),
        );
        expect(res.status).toBe(500);
        expect(calls).toBe(1);
    });

    it('hides handler-thrown DB error details with 500', async () => {
        const failingRepo: AssetsRepo = {
            ...makeRepo(),
            findByAssetId: async () => {
                throw new Error('relation "assets" does not exist on host db-internal');
            },
        };
        const app = createApp(deps({ repo: failingRepo }));
        const res = await call(app, '/query/getByAssetId', authed({ assetId: 'jup' }));
        expect(res.status).toBe(500);
        const payload = (await res.json()) as {
            error: string;
            message?: string;
        };
        expect(payload.error).toBe('handler_error');
        expect(payload.message).toBeUndefined();
    });
});

describe('getByAssetId', () => {
    it('returns the mapped row', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const res = await call(app, '/query/getByAssetId', authed({ assetId: 'jup' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            assetId: 'jup',
            category: 'crypto',
            aliases: ['JUP'],
            isActive: true,
            createdAt: NOW.getTime(),
            updatedAt: NOW.getTime(),
            name: 'Jupiter',
            symbol: 'JUP',
            coingeckoId: 'jupiter-exchange-solana',
            imageUrl: 'https://example.test/jup.png',
        });
    });

    it('returns null when row is missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/getByAssetId', authed({ assetId: 'missing' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('hides inactive rows unless includeInactive', async () => {
        const app = createApp(
            deps({
                repo: makeRepo({
                    byAssetId: { jup: sampleRow({ is_active: false }) },
                }),
            }),
        );
        const hidden = await call(app, '/query/getByAssetId', authed({ assetId: 'jup' }));
        expect(await hidden.json()).toBeNull();

        const visible = await call(app, '/query/getByAssetId', authed({ assetId: 'jup', includeInactive: true }));
        const body = (await visible.json()) as {
            assetId: string;
            isActive: boolean;
        };
        expect(body.assetId).toBe('jup');
        expect(body.isActive).toBe(false);
    });

    it('returns null for whitespace-trimmed-to-empty input', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const res = await call(app, '/query/getByAssetId', authed({ assetId: '   ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const cases: { body: string }[] = [
            { body: '{}' },
            { body: JSON.stringify({ assetId: 123 }) },
            {
                body: JSON.stringify({
                    assetId: 'jup',
                    includeInactive: 'yes',
                }),
            },
        ];
        for (const { body } of cases) {
            const res = await call(app, '/query/getByAssetId', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
            const payload = (await res.json()) as { error: string };
            expect(payload.error).toBe('invalid_args');
        }
    });
});

describe('getByAssetIds', () => {
    const repo = makeRepo({
        byAssetId: {
            jup: sampleRow(),
            sol: sampleRow({
                id: 'sol-1',
                asset_id: 'sol',
                symbol: 'SOL',
                name: 'Solana',
            }),
            inactive: sampleRow({
                id: 'i',
                asset_id: 'inactive',
                is_active: false,
            }),
        },
    });

    it('returns an entry per input id preserving order with nulls for misses', async () => {
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/getByAssetIds', authed({ assetIds: ['jup', 'missing', 'sol'] }));
        const body = (await res.json()) as Array<{
            assetId: string;
            asset: null | { assetId: string };
        }>;
        expect(body.map(e => e.assetId)).toEqual(['jup', 'missing', 'sol']);
        expect(body[0]!.asset?.assetId).toBe('jup');
        expect(body[1]!.asset).toBeNull();
        expect(body[2]!.asset?.assetId).toBe('sol');
    });

    it('hides inactive entries as null unless includeInactive', async () => {
        const app = createApp(deps({ repo }));
        const hidden = await call(app, '/query/getByAssetIds', authed({ assetIds: ['inactive'] }));
        const hiddenBody = (await hidden.json()) as Array<{ asset: unknown }>;
        expect(hiddenBody[0]!.asset).toBeNull();

        const visible = await call(
            app,
            '/query/getByAssetIds',
            authed({ assetIds: ['inactive'], includeInactive: true }),
        );
        const visibleBody = (await visible.json()) as Array<{
            asset: { isActive: boolean } | null;
        }>;
        expect(visibleBody[0]!.asset?.isActive).toBe(false);
    });

    it('trims and drops empty ids, caps at 500', async () => {
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/getByAssetIds', authed({ assetIds: ['  jup  ', '', '   '] }));
        const body = (await res.json()) as Array<{
            assetId: string;
            asset: { assetId: string } | null;
        }>;
        expect(body.length).toBe(1);
        expect(body[0]!.assetId).toBe('jup');
    });

    it('returns 400 when assetIds is not an array of strings', async () => {
        const app = createApp(deps({ repo }));
        for (const body of ['{}', JSON.stringify({ assetIds: 'jup' }), JSON.stringify({ assetIds: [1, 2] })]) {
            const res = await call(app, '/query/getByAssetIds', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
        }
    });

    it('returns empty array on auth failure', async () => {
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/getByAssetIds', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ assetIds: ['jup'] }),
        });
        expect(res.status).toBe(401);
    });
});

describe('search', () => {
    const jup = sampleRow();
    const sol = sampleRow({
        id: 'sol-1',
        asset_id: 'sol',
        symbol: 'SOL',
        name: 'Solana',
    });
    const usdc = sampleRow({
        id: 'usdc-1',
        asset_id: 'usdc',
        symbol: 'USDC',
        name: 'USD Coin',
        category: 'stablecoin',
        coingecko_id: 'usd-coin',
    });
    const inactiveOld = sampleRow({
        id: 'old',
        asset_id: 'oldcoin',
        symbol: 'OLD',
        name: 'Old Coin',
        is_active: false,
    });
    const validMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('returns [] for empty input', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/search', authed({ query: '   ' }));
        expect(await res.json()).toEqual([]);
    });

    it('resolves a valid solana mint to a single asset', async () => {
        const repo = makeRepo({
            byAssetId: { usdc },
            variantsByMint: {
                [validMint]: {
                    asset_id: 'usdc',
                    mint: validMint,
                    is_active: true,
                },
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/search', authed({ query: validMint }));
        const body = (await res.json()) as Array<{ assetId: string }>;
        expect(body.length).toBe(1);
        expect(body[0]!.assetId).toBe('usdc');
    });

    it('uses exact alias match (priority desc) before fuzzy paths', async () => {
        const repo = makeRepo({
            byAssetId: { jup, sol },
            aliasesByNormalized: {
                jup: [
                    {
                        alias: 'JUP',
                        normalized: 'jup',
                        asset_id: 'sol',
                        priority: 5,
                    },
                    {
                        alias: 'JUP',
                        normalized: 'jup',
                        asset_id: 'jup',
                        priority: 10,
                    },
                ],
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/search', authed({ query: 'JUP' }));
        const body = (await res.json()) as Array<{ assetId: string }>;
        expect(body[0]!.assetId).toBe('jup');
        expect(body[1]!.assetId).toBe('sol');
    });

    it('falls back to name fuzzy when no alias matches, respects category filter', async () => {
        const repo = makeRepo({
            byAssetId: { jup, sol, usdc },
            assetsNameFuzzy: { coin: [usdc, sol] },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/search', authed({ query: 'coin', category: 'stablecoin' }));
        const body = (await res.json()) as Array<{
            assetId: string;
            category: string;
        }>;
        expect(body.length).toBe(1);
        expect(body[0]!.assetId).toBe('usdc');
        expect(body[0]!.category).toBe('stablecoin');
    });

    it('hides inactive results unless includeInactive', async () => {
        const repo = makeRepo({
            byAssetId: { oldcoin: inactiveOld },
            assetsSymbolFuzzy: { OLD: [inactiveOld] },
        });
        const app = createApp(deps({ repo }));
        const hidden = await call(app, '/query/search', authed({ query: 'OLD' }));
        expect(await hidden.json()).toEqual([]);

        const visible = await call(app, '/query/search', authed({ query: 'OLD', includeInactive: true }));
        const body = (await visible.json()) as Array<{
            assetId: string;
            isActive: boolean;
        }>;
        expect(body[0]!.assetId).toBe('oldcoin');
        expect(body[0]!.isActive).toBe(false);
    });

    it('clamps limit and dedupes by assetId across stages', async () => {
        const repo = makeRepo({
            byAssetId: { jup },
            aliasesByNormalized: {
                jup: [
                    {
                        alias: 'JUP',
                        normalized: 'jup',
                        asset_id: 'jup',
                        priority: 1,
                    },
                ],
            },
            aliasesFuzzy: {
                JUP: [
                    {
                        alias: 'JUP',
                        normalized: 'jup',
                        asset_id: 'jup',
                        priority: 1,
                    },
                ],
            },
            assetsSymbolFuzzy: { JUP: [jup] },
            assetsNameFuzzy: { JUP: [jup] },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/search', authed({ query: 'JUP', limit: 100 }));
        const body = (await res.json()) as unknown[];
        expect(body.length).toBe(1);
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const cases = [
            JSON.stringify({}),
            JSON.stringify({ query: 123 }),
            JSON.stringify({ query: 'x', category: 'bogus' }),
            JSON.stringify({ query: 'x', limit: 'big' }),
            JSON.stringify({ query: 'x', includeInactive: 1 }),
        ];
        for (const body of cases) {
            const res = await call(app, '/query/search', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
        }
    });
});

describe('resolveAssetRef', () => {
    const jup = sampleRow();
    const sol = sampleRow({ id: 'sol-1', asset_id: 'sol', symbol: 'SOL' });
    const validMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('resolves by direct assetId', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup } }) }));
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: 'jup' }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            resolvedBy: 'assetId',
        });
    });

    it('resolves by alias with highest priority winning', async () => {
        const repo = makeRepo({
            byAssetId: { jup, sol },
            aliasesByNormalized: {
                jupiter: [
                    {
                        alias: 'Jupiter',
                        normalized: 'jupiter',
                        asset_id: 'sol',
                        priority: 1,
                    },
                    {
                        alias: 'Jupiter',
                        normalized: 'jupiter',
                        asset_id: 'jup',
                        priority: 99,
                    },
                ],
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: 'Jupiter' }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            resolvedBy: 'alias',
            alias: 'Jupiter',
        });
    });

    it('resolves by mint when ref looks like a Solana mint', async () => {
        const repo = makeRepo({
            byAssetId: { jup },
            variantsByMint: {
                [validMint]: {
                    asset_id: 'jup',
                    mint: validMint,
                    is_active: true,
                },
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: validMint }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            resolvedBy: 'mint',
            mint: validMint,
        });
    });

    it('returns null when no resolution', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: 'unknown' }));
        expect(await res.json()).toBeNull();
    });

    it('skips inactive assets unless includeInactive', async () => {
        const inactiveJup = sampleRow({ is_active: false });
        const repo = makeRepo({
            byAssetId: { jup: inactiveJup },
            aliasesByNormalized: {
                jupiter: [
                    {
                        alias: 'Jupiter',
                        normalized: 'jupiter',
                        asset_id: 'jup',
                        priority: 1,
                    },
                ],
            },
        });
        const app = createApp(deps({ repo }));

        const hidden = await call(app, '/query/resolveAssetRef', authed({ ref: 'jup' }));
        expect(await hidden.json()).toBeNull();

        const aliasHidden = await call(app, '/query/resolveAssetRef', authed({ ref: 'Jupiter' }));
        expect(await aliasHidden.json()).toBeNull();

        const visible = await call(app, '/query/resolveAssetRef', authed({ ref: 'jup', includeInactive: true }));
        expect(await visible.json()).toEqual({
            assetId: 'jup',
            resolvedBy: 'assetId',
        });
    });

    it('skips mint resolution when variant is inactive and includeInactive is false', async () => {
        const repo = makeRepo({
            byAssetId: { jup },
            variantsByMint: {
                [validMint]: {
                    asset_id: 'jup',
                    mint: validMint,
                    is_active: false,
                },
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: validMint }));
        expect(await res.json()).toBeNull();
    });

    it('returns null for empty/whitespace ref (not 400)', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/resolveAssetRef', authed({ ref: '   ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/resolveAssetRef', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('resolveAssetRefForApi', () => {
    const jup = sampleRow();
    const validMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('returns {assetId, ref, resolvedBy, mint:null} on direct assetId resolution', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup } }) }));
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: 'jup' }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            ref: 'jup',
            resolvedBy: 'assetId',
            mint: null,
        });
    });

    it('returns null when ref is in deletion tombstones', async () => {
        const app = createApp(
            deps({
                repo: makeRepo({
                    byAssetId: { jup },
                    deletedRefs: new Set(['jup']),
                }),
            }),
        );
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: 'jup' }));
        expect(await res.json()).toBeNull();
    });

    it('returns null when resolved asset has tombstoned coingeckoId', async () => {
        const app = createApp(
            deps({
                repo: makeRepo({
                    byAssetId: { jup },
                    deletedRefs: new Set(['jupiter-exchange-solana']),
                }),
            }),
        );
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: 'jup' }));
        expect(await res.json()).toBeNull();
    });

    it('falls back to assetId for the post-resolution tombstone check when coingeckoId is empty', async () => {
        const jupNoCg = sampleRow({ coingecko_id: '' });
        const repo = makeRepo({
            byAssetId: { jup: jupNoCg },
            aliasesByNormalized: {
                jupiter: [
                    {
                        alias: 'Jupiter',
                        normalized: 'jupiter',
                        asset_id: 'jup',
                        priority: 1,
                    },
                ],
            },
            deletedRefs: new Set(['jup']),
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: 'Jupiter' }));
        expect(await res.json()).toBeNull();
    });

    it('resolves by alias and reports mint:null', async () => {
        const repo = makeRepo({
            byAssetId: { jup },
            aliasesByNormalized: {
                jupiter: [
                    {
                        alias: 'Jupiter',
                        normalized: 'jupiter',
                        asset_id: 'jup',
                        priority: 1,
                    },
                ],
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: 'Jupiter' }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            ref: 'Jupiter',
            resolvedBy: 'alias',
            mint: null,
        });
    });

    it('resolves by mint and reports the mint', async () => {
        const repo = makeRepo({
            byAssetId: { jup },
            variantsByMint: {
                [validMint]: {
                    asset_id: 'jup',
                    mint: validMint,
                    is_active: true,
                },
            },
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: validMint }));
        expect(await res.json()).toEqual({
            assetId: 'jup',
            ref: validMint,
            resolvedBy: 'mint',
            mint: validMint,
        });
    });

    it('returns null for empty ref', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/resolveAssetRefForApi', authed({ ref: '' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/resolveAssetRefForApi', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ ref: 5 }),
        });
        expect(res.status).toBe(400);
    });
});

describe('listActiveWithCoinGeckoIds', () => {
    it('passes rows through in repo order, trimming coingeckoId', async () => {
        const a = sampleRow({
            id: 'a',
            asset_id: 'alpha',
            coingecko_id: ' alpha-id ',
        });
        const b = sampleRow({
            id: 'b',
            asset_id: 'beta',
            coingecko_id: 'beta-id',
        });
        const app = createApp(deps({ repo: makeRepo({ activeWithCoinGecko: [a, b] }) }));
        const res = await call(app, '/query/listActiveWithCoinGeckoIds', authed({}));
        const body = (await res.json()) as Array<{
            assetId: string;
            coingeckoId: string;
        }>;
        expect(body.map(e => e.assetId)).toEqual(['alpha', 'beta']);
        expect(body[0]!.coingeckoId).toBe('alpha-id');
    });

    it('includes description when present', async () => {
        const a = sampleRow({
            asset_id: 'a1',
            coingecko_id: 'cg',
            description: 'desc',
        });
        const app = createApp(deps({ repo: makeRepo({ activeWithCoinGecko: [a] }) }));
        const res = await call(app, '/query/listActiveWithCoinGeckoIds', authed({}));
        const body = (await res.json()) as Array<{ description?: string }>;
        expect(body[0]!.description).toBe('desc');
    });

    it('returns empty on no rows', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/listActiveWithCoinGeckoIds', authed({}));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 on invalid limit', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/listActiveWithCoinGeckoIds', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ limit: 'lots' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('listByCategory', () => {
    const jup = sampleRow();
    const sol = sampleRow({ id: 'sol-1', asset_id: 'sol', symbol: 'SOL' });
    const inactive = sampleRow({
        id: 'i',
        asset_id: 'inactive',
        is_active: false,
    });

    it('returns active assets for the given category', async () => {
        const repo = makeRepo({
            byCategory: [
                {
                    category: 'crypto',
                    includeInactive: false,
                    rows: [jup, sol],
                },
            ],
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/listByCategory', authed({ category: 'crypto' }));
        const body = (await res.json()) as Array<{ assetId: string }>;
        expect(body.map(r => r.assetId)).toEqual(['jup', 'sol']);
    });

    it('returns inactive entries when includeInactive=true', async () => {
        const repo = makeRepo({
            byCategory: [
                {
                    category: 'crypto',
                    includeInactive: true,
                    rows: [jup, sol, inactive],
                },
                {
                    category: 'crypto',
                    includeInactive: false,
                    rows: [jup, sol],
                },
            ],
        });
        const app = createApp(deps({ repo }));
        const res = await call(app, '/query/listByCategory', authed({ category: 'crypto', includeInactive: true }));
        const body = (await res.json()) as Array<{ assetId: string }>;
        expect(body.map(r => r.assetId)).toEqual(['jup', 'sol', 'inactive']);
    });

    it('returns [] when no rows match', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/listByCategory', authed({ category: 'etf' }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 on invalid category', async () => {
        const app = createApp(deps());
        const cases = [JSON.stringify({}), JSON.stringify({ category: 'bogus' })];
        for (const body of cases) {
            const res = await call(app, '/query/listByCategory', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
        }
    });
});

describe('x-tokens-identity header decoding', () => {
    it('returns 400 invalid_args on non-base64 x-tokens-identity', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const cases = ['{"clerkUserId":"user_1"}', 'not-base64!@#$', 'A', 'AAA'];
        for (const header of cases) {
            const res = await call(app, '/query/getByAssetId', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                    'x-tokens-identity': header,
                },
                body: JSON.stringify({ assetId: 'jup' }),
            });
            expect(res.status).toBe(400);
            const payload = (await res.json()) as {
                error: string;
                message?: string;
            };
            expect(payload.error).toBe('invalid_args');
            expect(payload.message).toBe('x-tokens-identity is not valid base64');
        }
    });

    it('returns 400 invalid_args on malformed identity payload', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const cases = [
            Buffer.from('not json', 'utf8').toString('base64'),
            Buffer.from(JSON.stringify(5), 'utf8').toString('base64'),
            Buffer.from(JSON.stringify({}), 'utf8').toString('base64'),
            Buffer.from(JSON.stringify({ clerkUserId: 123 }), 'utf8').toString('base64'),
            Buffer.from(JSON.stringify({ clerkUserId: '' }), 'utf8').toString('base64'),
            Buffer.from(JSON.stringify({ clerkUserId: 'u', projectId: 5 }), 'utf8').toString('base64'),
        ];
        for (const header of cases) {
            const res = await call(app, '/query/getByAssetId', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                    'x-tokens-identity': header,
                },
                body: JSON.stringify({ assetId: 'jup' }),
            });
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: string }).error).toBe('invalid_args');
        }
    });

    it('passes a valid identity through to identity-optional queries', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const res = await call(app, '/query/getByAssetId', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': encodeIdentity({
                    clerkUserId: 'user_1',
                    projectId: 'proj_1',
                }),
            },
            body: JSON.stringify({ assetId: 'jup' }),
        });
        expect(res.status).toBe(200);
    });
});

describe('POST /mutation/setAssetDescriptionByAssetId', () => {
    it('writes through the repo when identity + args are valid', async () => {
        const calls: {
            assetId: string;
            description: string | null;
            updatedAt: Date;
        }[] = [];
        const app = createApp(
            deps({
                repo: makeRepo({
                    byAssetId: { jup: sampleRow() },
                    descriptionCalls: calls,
                }),
            }),
        );
        const res = await call(app, '/mutation/setAssetDescriptionByAssetId', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': encodeIdentity({ clerkUserId: 'user_1' }),
            },
            body: JSON.stringify({
                assetId: 'jup',
                description: 'A new description',
            }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ updated: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.assetId).toBe('jup');
        expect(calls[0]!.description).toBe('A new description');
    });

    it('returns 401 identity_required when x-tokens-identity is missing', async () => {
        const app = createApp(deps({ repo: makeRepo({ byAssetId: { jup: sampleRow() } }) }));
        const res = await call(app, '/mutation/setAssetDescriptionByAssetId', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ assetId: 'jup', description: 'whatever' }),
        });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: string }).error).toBe('identity_required');
    });

    it('returns 400 invalid_args on missing assetId', async () => {
        const app = createApp(deps());
        const res = await call(app, '/mutation/setAssetDescriptionByAssetId', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': encodeIdentity({ clerkUserId: 'user_1' }),
            },
            body: JSON.stringify({ description: 'no asset id' }),
        });
        expect(res.status).toBe(400);
    });

    it('returns 404 on unknown mutation name', async () => {
        const app = createApp(deps());
        const res = await call(app, '/mutation/doesNotExist', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'x-tokens-identity': encodeIdentity({ clerkUserId: 'user_1' }),
            },
            body: '{}',
        });
        expect(res.status).toBe(404);
    });

    it('returns 401 on bad bearer for mutations', async () => {
        const app = createApp(deps());
        const res = await call(app, '/mutation/setAssetDescriptionByAssetId', {
            method: 'POST',
            body: '{}',
        });
        expect(res.status).toBe(401);
    });
});

describe('POST /mutation/cacheWarm*', () => {
    // Minimal deps: cacheWarmRequest short-circuits on the mint-exists guard,
    // so only `cron.repo.findVariantByMint` is exercised here. Handler-level
    // behavior is covered in handlers/cacheWarm.test.ts.
    function makeCacheWarmDeps(): CacheWarmDeps {
        return {
            cron: {
                repo: {
                    async findVariantByMint() {
                        return null;
                    },
                },
            },
            env: () => ({}),
            now: () => 0,
        } as unknown as CacheWarmDeps;
    }

    it('returns 404 when cacheWarmDeps are not wired', async () => {
        const app = createApp(deps());
        const res = await call(app, '/mutation/cacheWarmRequest', authed({ mint: 'abc' }));
        expect(res.status).toBe(404);
    });

    it('returns 401 on bad bearer even when registered', async () => {
        const app = createApp(deps({ cacheWarmDeps: makeCacheWarmDeps() }));
        const res = await call(app, '/mutation/cacheWarmRequest', {
            method: 'POST',
            headers: {
                authorization: 'Bearer wrong',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mint: 'abc' }),
        });
        expect(res.status).toBe(401);
    });

    it('dispatches cacheWarmRequest and ignores the legacy secret arg', async () => {
        const app = createApp(deps({ cacheWarmDeps: makeCacheWarmDeps() }));
        const res = await call(app, '/mutation/cacheWarmRequest', authed({ secret: 'legacy', mint: 'abc' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            mint: 'abc',
            scheduled: [],
            skipped: ['unknown_mint'],
        });
    });

    it('maps InvalidArgsError from cacheWarm handlers to 400 invalid_args', async () => {
        const app = createApp(deps({ cacheWarmDeps: makeCacheWarmDeps() }));
        const res = await call(app, '/mutation/cacheWarmRequest', authed({}));
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('invalid_args');
    });

    it('registers all cacheWarm mutation names', async () => {
        const app = createApp(deps({ cacheWarmDeps: makeCacheWarmDeps() }));
        const names = [
            'cacheWarmRequest',
            'cacheWarmRequestCoingeckoOhlcv',
            'cacheWarmRequestCoinPrice',
            'cacheWarmRequestCoinMetadata',
            'cacheWarmRequestCoingeckoTickers',
            'cacheWarmRequestStockPrice',
            'cacheWarmRequestStockOhlcv',
            'cacheWarmRequestAssetRisk',
            'cacheWarmRequestMintsWarm',
            'cacheWarmRequestCuratedListWarm',
            'cacheWarmRequestRegistrySeed',
            'cacheWarmSetAssetLogoUrl',
        ];
        for (const name of names) {
            // Empty args -> 400 invalid_args (not 404), proving the route exists.
            const res = await call(app, `/mutation/${name}`, authed({}));
            expect([200, 400]).toContain(res.status);
        }
    });
});

describe('listDeletedRefs', () => {
    it('returns matched normalized refs, dedupes, trims', async () => {
        const tombs: AssetDeletionTombstonesRepo = {
            async findDeletedNormalizedRefs(refs) {
                return refs.filter(r => r === 'bonk' || r === 'sol');
            },
        };
        const app = createApp(deps({ deletionTombstonesRepo: tombs }));
        const res = await call(app, '/query/listDeletedRefs', authed({ refs: [' BONK ', 'bonk', 'SOL', 'unknown'] }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(['bonk', 'sol']);
    });

    it('returns [] for empty refs array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/listDeletedRefs', authed({ refs: [] }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 when refs is not an array of strings', async () => {
        const app = createApp(deps());
        for (const body of ['{}', JSON.stringify({ refs: 'bonk' }), JSON.stringify({ refs: [1] })]) {
            const res = await call(app, '/query/listDeletedRefs', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
        }
    });
});

const sampleSanctumRow = (overrides: Partial<SanctumLstRow> = {}): SanctumLstRow => ({
    mint: 'mint1',
    symbol: 'jitoSOL',
    symbol_lower: 'jitosol',
    name: 'Jito Staked SOL',
    logo_uri: 'https://example.test/jitosol.png',
    website_url: 'https://jito.network',
    tvl_usd: 1_000_000,
    apy: 0.07,
    source_rank: 10,
    is_active: true,
    last_seen_at: 1,
    last_synced_at: 2,
    created_at: 3,
    updated_at: 4,
    ...overrides,
});

describe('sanctumListActive', () => {
    it('maps rows to camelCase, omitting nulls', async () => {
        const row = sampleSanctumRow();
        const repo: SanctumLstsRepo = {
            async listActive() {
                return [row];
            },
            async findByMint() {
                return null;
            },
            async findActiveBySymbolLower() {
                return [];
            },
        };
        const app = createApp(deps({ sanctumLstsRepo: repo }));
        const res = await call(app, '/query/sanctumListActive', authed({ limit: 100 }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{
            mint: string;
            symbol?: string;
            tvlUsd?: number;
        }>;
        expect(body.length).toBe(1);
        expect(body[0]!.mint).toBe('mint1');
        expect(body[0]!.symbol).toBe('jitoSOL');
        expect(body[0]!.tvlUsd).toBe(1_000_000);
    });

    it('omits optional fields that are null in DB', async () => {
        const row = sampleSanctumRow({
            symbol: null,
            name: null,
            logo_uri: null,
            website_url: null,
            tvl_usd: null,
            apy: null,
        });
        const repo: SanctumLstsRepo = {
            async listActive() {
                return [row];
            },
            async findByMint() {
                return null;
            },
            async findActiveBySymbolLower() {
                return [];
            },
        };
        const app = createApp(deps({ sanctumLstsRepo: repo }));
        const res = await call(app, '/query/sanctumListActive', authed({}));
        const body = (await res.json()) as Array<Record<string, unknown>>;
        expect(body[0]).not.toHaveProperty('symbol');
        expect(body[0]).not.toHaveProperty('tvlUsd');
        expect(body[0]).not.toHaveProperty('apy');
        expect(body[0]!.mint).toBe('mint1');
        expect(body[0]!.symbolLower).toBe('jitosol');
    });

    it('returns 400 on invalid limit', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/sanctumListActive', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ limit: 'big' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('sanctumResolveRef', () => {
    const validMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('resolves by mint when ref looks like a Solana mint', async () => {
        const row = sampleSanctumRow({ mint: validMint });
        const repo: SanctumLstsRepo = {
            async listActive() {
                return [];
            },
            async findByMint(m) {
                return m === validMint ? row : null;
            },
            async findActiveBySymbolLower() {
                return [];
            },
        };
        const app = createApp(deps({ sanctumLstsRepo: repo }));
        const res = await call(app, '/query/sanctumResolveRef', authed({ ref: validMint }));
        expect(await res.json()).toEqual({
            mint: validMint,
            symbol: 'jitoSOL',
            sourceRank: 10,
        });
    });

    it('resolves by symbol lowercased, picking lowest sourceRank', async () => {
        const a = sampleSanctumRow({ mint: 'A', source_rank: 50 });
        const b = sampleSanctumRow({ mint: 'B', source_rank: 5 });
        const repo: SanctumLstsRepo = {
            async listActive() {
                return [];
            },
            async findByMint() {
                return null;
            },
            async findActiveBySymbolLower() {
                return [a, b];
            },
        };
        const app = createApp(deps({ sanctumLstsRepo: repo }));
        const res = await call(app, '/query/sanctumResolveRef', authed({ ref: 'JITOSOL' }));
        const body = (await res.json()) as { mint: string; sourceRank: number };
        expect(body.mint).toBe('B');
        expect(body.sourceRank).toBe(5);
    });

    it('returns null when no resolution', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/sanctumResolveRef', authed({ ref: 'unknown' }));
        expect(await res.json()).toBeNull();
    });

    it('returns null for empty/whitespace ref', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/sanctumResolveRef', authed({ ref: '   ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on missing ref', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/sanctumResolveRef', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

const sampleAssetMarket = (overrides: Partial<AssetMarketRow> = {}): AssetMarketRow => ({
    asset_id: 'sol',
    liquidity: 1234,
    volume_24h_usd: 5678,
    volume_30d_usd: null,
    primary_mint: 'So11111111111111111111111111111111111111112',
    last_computed_at: 100,
    min_variant_last_fetched_at: 50,
    max_variant_last_fetched_at: 60,
    ...overrides,
});

describe('assetMarketsGetLatestByAssetId', () => {
    it('maps the row to camelCase', async () => {
        const row = sampleAssetMarket();
        const repo: AssetMarketsRepo = {
            async findLatestByAssetId(id) {
                return id === 'sol' ? row : null;
            },
            async findLatestByAssetIds() {
                return [];
            },
        };
        const app = createApp(deps({ assetMarketsRepo: repo }));
        const res = await call(app, '/query/assetMarketsGetLatestByAssetId', authed({ assetId: 'sol' }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assetId).toBe('sol');
        expect(body.liquidity).toBe(1234);
        expect(body.volume24hUSD).toBe(5678);
        expect(body.primaryMint).toBe('So11111111111111111111111111111111111111112');
        expect(body.minVariantLastFetchedAt).toBe(50);
        expect(body.maxVariantLastFetchedAt).toBe(60);
    });

    it('returns null when missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetMarketsGetLatestByAssetId', authed({ assetId: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetMarketsGetLatestByAssetId', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ assetId: 5 }),
        });
        expect(res.status).toBe(400);
    });
});

describe('assetMarketsGetLatestByAssetIds', () => {
    it('returns one entry per input id preserving order; null when missing', async () => {
        const sol = sampleAssetMarket();
        const repo: AssetMarketsRepo = {
            async findLatestByAssetId() {
                return null;
            },
            async findLatestByAssetIds(ids) {
                return ids.includes('sol') ? [sol] : [];
            },
        };
        const app = createApp(deps({ assetMarketsRepo: repo }));
        const res = await call(app, '/query/assetMarketsGetLatestByAssetIds', authed({ assetIds: ['sol', 'missing'] }));
        const body = (await res.json()) as Array<{
            assetId: string;
            market: null | { assetId: string };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.assetId).toBe('sol');
        expect(body[0]!.market?.assetId).toBe('sol');
        expect(body[1]!.market).toBeNull();
    });

    it('returns 400 when assetIds is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetMarketsGetLatestByAssetIds', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ assetIds: 'sol' }),
        });
        expect(res.status).toBe(400);
    });
});

const sampleVariantMarketRow = (overrides: Partial<VariantMarketRow> = {}): VariantMarketRow => ({
    mint: 'm1',
    source: 'birdeye',
    metrics_source: null,
    birdeye_metrics: null,
    rwa_metrics: null,
    clickhouse_metrics: null,
    symbol: 'BONK',
    name: 'Bonk',
    decimals: 5,
    logo_uri: 'https://example.test/bonk.png',
    price: 0.00002,
    liquidity: 1000,
    volume_1h_usd: null,
    volume_24h_usd: 2000,
    trade_1h: null,
    trade_24h: null,
    unique_wallet_1h: null,
    unique_wallet_24h: null,
    market_cap: 50000,
    fdv: null,
    price_change_24h_percent: 1.5,
    price_change_1h_percent: null,
    holder: null,
    total_supply: null,
    circulating_supply: null,
    last_trade_human_time: null,
    extensions: null,
    as_of: null,
    last_trade_at: null,
    last_fetched_at: 1_000_000,
    overview_last_fetched_at: null,
    ...overrides,
});

describe('variantMarketsGetLatestByMints', () => {
    it('returns mapped market snapshot per mint', async () => {
        const row = sampleVariantMarketRow();
        const repo: VariantMarketsRepo = {
            async findLatestByMints(mints) {
                return mints.includes('m1') ? [row] : [];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1', 'absent'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: null | Record<string, unknown>;
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.mint).toBe('m1');
        expect(body[0]!.market?.source).toBe('birdeye');
        expect(body[0]!.market?.lastFetchedAt).toBe(1_000_000);
        expect(body[0]!.market?.symbol).toBe('BONK');
        expect(body[0]!.market?.liquidity).toBe(1000);
        expect(body[1]!.market).toBeNull();
    });

    it('serves fresh clickhouse metrics over a stale birdeye snapshot', async () => {
        const now = 1_780_000_000_000;
        const row = sampleVariantMarketRow({
            metrics_source: 'clickhouse_trades',
            birdeye_metrics: {
                source: 'birdeye',
                price: 1.11,
                volume1hUSD: 100,
                volume24hUSD: 1_000,
                trade24h: 5,
                liquidity: 9_999,
                lastFetchedAt: now - 60 * 60_000,
            },
            clickhouse_metrics: {
                source: 'clickhouse_trades',
                price: 2.22,
                volume1hUSD: 200,
                volume24hUSD: 2_000,
                trade1h: 10,
                trade24h: 240,
                uniqueWallet1h: 5,
                uniqueWallet24h: 50,
                priceChange1hPercent: 1.5,
                priceChange24hPercent: -2,
                lastTradeAt: now - 30_000,
                lastFetchedAt: now,
            },
            last_fetched_at: now,
        });
        const repo: VariantMarketsRepo = {
            async findLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: Record<string, unknown>;
        }>;
        expect(body[0]!.market.metricsSource).toBe('clickhouse_trades');
        expect(body[0]!.market.price).toBe(2.22);
        expect(body[0]!.market.volume1hUSD).toBe(200);
        expect(body[0]!.market.volume24hUSD).toBe(2_000);
        expect(body[0]!.market.trade24h).toBe(240);
        expect(body[0]!.market.uniqueWallet24h).toBe(50);
        expect(body[0]!.market.lastFetchedAt).toBe(now);
        expect(body[0]!.market.liquidity).toBe(9_999);
        expect(body[0]!.market.source).toBe('birdeye');
    });

    it('demotes a legacy birdeye blob lacking lastFetchedAt when the overview is stale', async () => {
        const now = 1_780_000_000_000;
        const row = sampleVariantMarketRow({
            metrics_source: 'clickhouse_trades',
            birdeye_metrics: {
                source: 'birdeye',
                price: 1.11,
                volume24hUSD: 1_000,
            },
            clickhouse_metrics: {
                source: 'clickhouse_trades',
                price: 2.22,
                volume24hUSD: 2_000,
                lastFetchedAt: now,
            },
            overview_last_fetched_at: now - 60 * 60_000,
            last_fetched_at: now,
        });
        const repo: VariantMarketsRepo = {
            async findLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: Record<string, unknown>;
        }>;
        expect(body[0]!.market.metricsSource).toBe('clickhouse_trades');
        expect(body[0]!.market.price).toBe(2.22);
        expect(body[0]!.market.volume24hUSD).toBe(2_000);
    });

    it('keeps serving birdeye when its snapshot is fresh', async () => {
        const now = 1_780_000_000_000;
        const row = sampleVariantMarketRow({
            metrics_source: 'clickhouse_trades',
            birdeye_metrics: {
                source: 'birdeye',
                price: 1.11,
                volume24hUSD: 1_000,
                lastFetchedAt: now - 5 * 60_000,
            },
            clickhouse_metrics: {
                source: 'clickhouse_trades',
                price: 2.22,
                volume24hUSD: 2_000,
                lastFetchedAt: now,
            },
            last_fetched_at: now,
        });
        const repo: VariantMarketsRepo = {
            async findLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: Record<string, unknown>;
        }>;
        expect(body[0]!.market.metricsSource).toBe('birdeye');
        expect(body[0]!.market.price).toBe(1.11);
        expect(body[0]!.market.volume24hUSD).toBe(1_000);
    });

    it('serves birdeye unchanged when no clickhouse snapshot exists', async () => {
        const now = 1_780_000_000_000;
        const row = sampleVariantMarketRow({
            birdeye_metrics: {
                source: 'birdeye',
                price: 1.11,
                volume24hUSD: 1_000,
                lastFetchedAt: now - 60 * 60_000,
            },
            last_fetched_at: now - 60 * 60_000,
        });
        const repo: VariantMarketsRepo = {
            async findLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: Record<string, unknown>;
        }>;
        expect(body[0]!.market.metricsSource).toBe('birdeye');
        expect(body[0]!.market.price).toBe(1.11);
        expect(body[0]!.market.volume24hUSD).toBe(1_000);
    });

    it('falls back to birdeye fields the clickhouse snapshot lacks', async () => {
        const now = 1_780_000_000_000;
        const row = sampleVariantMarketRow({
            metrics_source: 'clickhouse_trades',
            price_change_24h_percent: null,
            birdeye_metrics: {
                source: 'birdeye',
                price: 1.11,
                priceChange24hPercent: 3.3,
                lastFetchedAt: now - 60 * 60_000,
            },
            clickhouse_metrics: {
                source: 'clickhouse_trades',
                price: 2.22,
                lastFetchedAt: now,
            },
            last_fetched_at: now,
        });
        const repo: VariantMarketsRepo = {
            async findLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ variantMarketsRepo: repo }));
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: ['m1'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            market: Record<string, unknown>;
        }>;
        expect(body[0]!.market.price).toBe(2.22);
        expect(body[0]!.market.priceChange24hPercent).toBe(3.3);
    });

    it('returns [] for empty mints', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/variantMarketsGetLatestByMints', authed({ mints: [] }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 when mints is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/variantMarketsGetLatestByMints', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mints: 'm1' }),
        });
        expect(res.status).toBe(400);
    });
});

const sampleVariantDocRow = (overrides: Partial<AssetVariantDocRow> = {}): AssetVariantDocRow => ({
    asset_id: 'solana',
    chain: 'solana',
    mint: 'So11111111111111111111111111111111111111112',
    variant_id: 'solana:native',
    kind: 'native',
    trust_tier: 'tier1',
    stock_variant_tier: null,
    tags: ['native'],
    issuer: null,
    issuer_url: null,
    label: null,
    is_active: true,
    created_at: 1,
    updated_at: 2,
    ...overrides,
});

describe('assetVariantsGetByMint', () => {
    it('maps row to camelCase result', async () => {
        const row = sampleVariantDocRow();
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findVariantByMint(m) {
                return m === row.mint ? row : null;
            },
            async findAssetIsActive() {
                return true;
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(app, '/query/assetVariantsGetByMint', authed({ mint: row.mint }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assetId).toBe('solana');
        expect(body.chain).toBe('solana');
        expect(body.mint).toBe(row.mint);
        expect(body.variantId).toBe('solana:native');
        expect(body.kind).toBe('native');
        expect(body.trustTier).toBe('tier1');
        expect(body.tags).toEqual(['native']);
    });

    it('hides inactive variant unless includeInactive', async () => {
        const row = sampleVariantDocRow({ is_active: false });
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findVariantByMint() {
                return row;
            },
            async findAssetIsActive() {
                return true;
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const hidden = await call(app, '/query/assetVariantsGetByMint', authed({ mint: row.mint }));
        expect(await hidden.json()).toBeNull();
        const visible = await call(
            app,
            '/query/assetVariantsGetByMint',
            authed({ mint: row.mint, includeInactive: true }),
        );
        const body = (await visible.json()) as { isActive: boolean };
        expect(body.isActive).toBe(false);
    });

    it('hides variant when parent asset is inactive', async () => {
        const row = sampleVariantDocRow();
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findVariantByMint() {
                return row;
            },
            async findAssetIsActive() {
                return false;
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(app, '/query/assetVariantsGetByMint', authed({ mint: row.mint }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetVariantsGetByMint', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('assetVariantsListByAssetIds', () => {
    it('groups variants by asset id preserving input order', async () => {
        const solVariant = sampleVariantDocRow();
        const jupVariant = sampleVariantDocRow({
            asset_id: 'jup',
            mint: 'jupMint',
            variant_id: 'jup:native',
        });
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findVariantsByAssetIds(ids) {
                const result: AssetVariantDocRow[] = [];
                if (ids.includes('solana')) result.push(solVariant);
                if (ids.includes('jup')) result.push(jupVariant);
                return result;
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(
            app,
            '/query/assetVariantsListByAssetIds',
            authed({ assetIds: ['jup', 'solana', 'missing'] }),
        );
        const body = (await res.json()) as Array<{
            assetId: string;
            variants: Array<{ mint: string }>;
        }>;
        expect(body.map(e => e.assetId)).toEqual(['jup', 'solana', 'missing']);
        expect(body[0]!.variants[0]!.mint).toBe('jupMint');
        expect(body[1]!.variants[0]!.mint).toBe(solVariant.mint);
        expect(body[2]!.variants).toEqual([]);
    });

    it('returns 400 when assetIds is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetVariantsListByAssetIds', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ assetIds: 'solana' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('assetVariantsListByMints', () => {
    it('returns one entry per input mint with null for unknown using a batched lookup', async () => {
        const variant = sampleVariantDocRow();
        let batchCalls = 0;
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findVariantsByMints(requested) {
                batchCalls += 1;
                return requested.includes(variant.mint) ? [variant] : [];
            },
            async findAssetIsActive() {
                return true;
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(app, '/query/assetVariantsListByMints', authed({ mints: [variant.mint, 'missing'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            variant: null | { mint: string };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.variant?.mint).toBe(variant.mint);
        expect(body[1]!.variant).toBeNull();
        expect(batchCalls).toBe(1);
    });

    it('returns 400 when mints is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetVariantsListByMints', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('assetVariantsGetSolanaDefaultVariantsViewForApi', () => {
    it('returns parsed view payload', async () => {
        const variantsJson = JSON.stringify([
            {
                variantId: 'solana:native',
                mint: 'mint1',
                kind: 'native',
                tags: ['native'],
                liquidityTier: 'tier1',
                trustTier: 'tier1',
                market: null,
            },
        ]);
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findSolanaDefaultVariantsView() {
                return { variants_json: variantsJson, updated_at: 9999 };
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(app, '/query/assetVariantsGetSolanaDefaultVariantsViewForApi', authed({}));
        const body = (await res.json()) as {
            assetId: string;
            updatedAt: number;
            variants: Array<{ mint: string }>;
        };
        expect(body.assetId).toBe('solana');
        expect(body.updatedAt).toBe(9999);
        expect(body.variants[0]!.mint).toBe('mint1');
    });

    it('returns null when the view row is missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetVariantsGetSolanaDefaultVariantsViewForApi', authed({}));
        expect(await res.json()).toBeNull();
    });
});

describe('assetVariantsListSolanaVariantsForApi', () => {
    it('returns variants computed from repo data', async () => {
        const v1 = sampleVariantDocRow({ mint: 'M1', kind: 'native' });
        const v2 = sampleVariantDocRow({ mint: 'M2', kind: 'wrapped' });
        const marketRow = sampleVariantMarketRowForView({
            mint: 'M1',
            liquidity: 5_000_000,
        });
        const repo: AssetVariantsRepo = {
            ...emptyAssetVariantsRepo(),
            async findActiveSolanaVariants() {
                return [v1, v2];
            },
            async findVariantMarketsByMints(mints) {
                return mints.includes('M1') ? [marketRow] : [];
            },
        };
        const app = createApp(deps({ assetVariantsRepo: repo }));
        const res = await call(app, '/query/assetVariantsListSolanaVariantsForApi', authed({}));
        const body = (await res.json()) as {
            assetId: string;
            requestedMintIsVariant: boolean;
            variants: Array<{
                mint: string;
                liquidityTier: string;
                market: null | { liquidity: number | null };
            }>;
        };
        expect(body.assetId).toBe('solana');
        expect(body.requestedMintIsVariant).toBe(true);
        expect(body.variants.length).toBe(2);
        expect(body.variants[0]!.mint).toBe('M1');
        expect(body.variants[0]!.liquidityTier).toBe('tier2');
        expect(body.variants[1]!.mint).toBe('M2');
        expect(body.variants[1]!.market).toBeNull();
    });

    it('returns 400 on invalid kind', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetVariantsListSolanaVariantsForApi', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ kind: 'bogus' }),
        });
        expect(res.status).toBe(400);
    });
});

function sampleVariantMarketRowForView(overrides: Partial<VariantMarketRow> = {}): VariantMarketRow {
    return sampleVariantMarketRow(overrides);
}

describe('assetsApiLoadAssetBaseForApi', () => {
    const NOW_MS = NOW.getTime();
    const jupAssetRow: AssetsApiAssetRow = {
        asset_id: 'jup',
        category: 'crypto',
        name: 'Jupiter',
        symbol: 'JUP',
        aliases: ['JUP'],
        coingecko_id: 'jupiter-exchange-solana',
        description: null,
        image_url: 'https://example.test/jup.png',
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
    };
    const jupMint = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const jupVariantRow: AssetsApiVariantRow = {
        asset_id: 'jup',
        chain: 'solana',
        mint: jupMint,
        variant_id: 'jup:solana',
        kind: 'native',
        trust_tier: 'tier1',
        stock_variant_tier: null,
        tags: ['liquid'],
        issuer: null,
        issuer_url: null,
        label: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
    };
    const jupVariantMarketRow: AssetsApiVariantMarketRow = {
        mint: jupMint,
        source: 'birdeye',
        metrics_source: 'birdeye',
        birdeye_metrics: { source: 'birdeye' },
        rwa_metrics: null,
        clickhouse_metrics: null,
        symbol: 'JUP',
        name: 'Jupiter',
        decimals: 6,
        logo_uri: 'https://example.test/jup.png',
        price: 1.23,
        liquidity: 4_000_000,
        volume_5m_usd: null,
        volume_15m_usd: null,
        volume_1h_usd: 12_345,
        volume_6h_usd: null,
        volume_24h_usd: 200_000,
        trade_5m: null,
        trade_15m: null,
        trade_1h: 50,
        trade_6h: null,
        trade_24h: 1_000,
        unique_wallet_5m: null,
        unique_wallet_1h: null,
        unique_wallet_24h: 500,
        market_cap: 12_000_000,
        fdv: null,
        price_change_24h_percent: 1.5,
        price_change_1h_percent: 0.1,
        holder: 10_000,
        total_supply: null,
        circulating_supply: null,
        last_trade_human_time: '2026-06-01T00:00:00Z',
        extensions: { coingeckoId: 'jupiter-exchange-solana' },
        as_of: NOW_MS,
        last_trade_at: NOW_MS,
        last_fetched_at: NOW_MS,
        overview_last_fetched_at: NOW_MS,
    };
    const jupFillQualityRow: AssetsApiFillQualityRow = {
        mint: jupMint,
        source: 'clickhouse_fill_quality',
        range_identifier: '24h',
        horizon: '5s',
        quote_mint: 'usdc',
        volume_24h_usd: 100_000,
        trade_24h: 1_000,
        bot_volume_24h_usd: 50_000,
        bot_trade_24h: 500,
        bot_volume_ratio: 0.5,
        fee_24h_usd: 250,
        fee_bps: 25,
        flow_source_count: 3,
        markout_pnl_24h_usd: 12.5,
        markout_count: 7,
        markout_bps: 2.5,
        execution_score: 0.9,
        is_eligible_for_primary: true,
        as_of: NOW_MS,
        last_computed_at: NOW_MS,
    };
    const jupAssetMarketRow: AssetsApiAssetMarketRow = {
        asset_id: 'jup',
        liquidity: 4_000_000,
        volume_24h_usd: 200_000,
        volume_30d_usd: 6_000_000,
        primary_mint: jupMint,
        last_computed_at: NOW_MS,
        min_variant_last_fetched_at: NOW_MS - 1000,
        max_variant_last_fetched_at: NOW_MS,
    };
    const jupCoingeckoCoinRow: AssetsApiCoingeckoCoinRow = {
        coin_id: 'jupiter-exchange-solana',
        symbol: 'jup',
        name: 'Jupiter',
        platforms: { solana: jupMint },
        last_synced_at: NOW_MS,
        coin: { id: 'jupiter-exchange-solana', symbol: 'jup' },
        last_metadata_fetched_at: NOW_MS,
    };

    it('returns asset + variants happy path with all include flags', async () => {
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [jupVariantRow] },
            variantMarketsByMint: { [jupMint]: jupVariantMarketRow },
            fillQualityByMint: { [jupMint]: jupFillQualityRow },
            assetMarketByAssetId: { jup: jupAssetMarketRow },
            coingeckoCoinByCoinId: {
                'jupiter-exchange-solana': jupCoingeckoCoinRow,
            },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({
                assetId: 'jup',
                includeVariants: true,
                includeVariantMarkets: true,
                includeFillQuality: true,
                includeAssetMarket: true,
                includeCoingeckoCoin: true,
            }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect((body.asset as { assetId: string }).assetId).toBe('jup');
        expect((body.asset as { createdAt: number }).createdAt).toBe(NOW_MS);
        expect((body.asset as { imageUrl: string }).imageUrl).toBe('https://example.test/jup.png');
        const variants = body.variants as Array<{
            mint: string;
            trustTier: string;
            tags: string[];
        }>;
        expect(variants).toHaveLength(1);
        expect(variants[0]!.mint).toBe(jupMint);
        expect(variants[0]!.trustTier).toBe('tier1');
        const variantMarkets = body.variantMarkets as Array<{
            mint: string;
            market: Record<string, unknown> | null;
        }>;
        expect(variantMarkets).toHaveLength(1);
        expect(variantMarkets[0]!.mint).toBe(jupMint);
        expect((variantMarkets[0]!.market as { source: string }).source).toBe('birdeye');
        expect((variantMarkets[0]!.market as { logoURI: string }).logoURI).toBe('https://example.test/jup.png');
        expect((variantMarkets[0]!.market as { lastFetchedAt: number }).lastFetchedAt).toBe(NOW_MS);
        const fillQuality = body.fillQuality as Array<{
            mint: string;
            fillQuality: Record<string, unknown> | null;
        }>;
        expect(fillQuality).toHaveLength(1);
        expect((fillQuality[0]!.fillQuality as { executionScore: number }).executionScore).toBe(0.9);
        expect((body.assetMarket as { primaryMint: string }).primaryMint).toBe(jupMint);
        expect((body.coingeckoCoin as { id: string }).id).toBe('jupiter-exchange-solana');
    });

    it('returns {asset: null, variants: []} when asset is missing', async () => {
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: makeAssetsApiRepo() }));
        const res = await call(app, '/query/assetsApiLoadAssetBaseForApi', authed({ assetId: 'unknown' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ asset: null, variants: [] });
    });

    it('hides inactive asset unless includeInactive=true', async () => {
        const inactive: AssetsApiAssetRow = {
            ...jupAssetRow,
            is_active: false,
        };
        const repo = makeAssetsApiRepo({ assetsByAssetId: { jup: inactive } });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));

        const hidden = await call(app, '/query/assetsApiLoadAssetBaseForApi', authed({ assetId: 'jup' }));
        expect(await hidden.json()).toEqual({ asset: null, variants: [] });

        const visible = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({ assetId: 'jup', includeInactive: true }),
        );
        const body = (await visible.json()) as {
            asset: { isActive: boolean } | null;
        };
        expect(body.asset?.isActive).toBe(false);
    });

    it('returns [] variants when includeVariants=false', async () => {
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [jupVariantRow] },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({ assetId: 'jup', includeVariants: false }),
        );
        const body = (await res.json()) as {
            variants: unknown[];
            variantMarkets?: unknown;
        };
        expect(body.variants).toEqual([]);
        expect(body.variantMarkets).toBeUndefined();
    });

    it('emits null entries for variantMarkets/fillQuality when row is missing', async () => {
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [jupVariantRow] },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({
                assetId: 'jup',
                includeVariants: true,
                includeVariantMarkets: true,
                includeFillQuality: true,
            }),
        );
        const body = (await res.json()) as {
            variantMarkets: Array<{ mint: string; market: unknown }>;
            fillQuality: Array<{ mint: string; fillQuality: unknown }>;
        };
        expect(body.variantMarkets).toEqual([{ mint: jupMint, market: null }]);
        expect(body.fillQuality).toEqual([{ mint: jupMint, fillQuality: null }]);
    });

    it('applies the logoURI fallback when variant market has no logo_uri', async () => {
        const tbtcMint = '6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU';
        const tbtcVariant: AssetsApiVariantRow = {
            ...jupVariantRow,
            mint: tbtcMint,
        };
        const tbtcMarket: AssetsApiVariantMarketRow = {
            ...jupVariantMarketRow,
            mint: tbtcMint,
            logo_uri: null,
        };
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [tbtcVariant] },
            variantMarketsByMint: { [tbtcMint]: tbtcMarket },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({
                assetId: 'jup',
                includeVariants: true,
                includeVariantMarkets: true,
            }),
        );
        const body = (await res.json()) as {
            variantMarkets: Array<{ market: { logoURI?: string } | null }>;
        };
        expect(body.variantMarkets[0]!.market?.logoURI).toBe('/logos/popular/tbtc-logo.png');
    });

    it('emits explicit null for assetMarket/coingeckoCoin/stockInstrument/stockPrice when row missing but flag set', async () => {
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [jupVariantRow] },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({
                assetId: 'jup',
                includeAssetMarket: true,
                includeCoingeckoCoin: true,
                includeStockInstrument: true,
                includeStockPrice: true,
            }),
        );
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assetMarket).toBeNull();
        expect(body.coingeckoCoin).toBeNull();
        expect(body.stockInstrument).toBeNull();
        expect(body.stockPrice).toBeNull();
    });

    it('omits coingeckoCoin lookup when assetRow.coingecko_id is empty', async () => {
        let coingeckoCalls = 0;
        const repo: AssetsApiRepo = {
            ...makeAssetsApiRepo({
                assetsByAssetId: {
                    jup: { ...jupAssetRow, coingecko_id: null },
                },
                activeVariantsByAssetId: { jup: [jupVariantRow] },
                coingeckoCoinByCoinId: {
                    'jupiter-exchange-solana': jupCoingeckoCoinRow,
                },
            }),
            findCoingeckoCoinByCoinId: async coinId => {
                coingeckoCalls++;
                return { ...jupCoingeckoCoinRow, coin_id: coinId };
            },
        };
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({ assetId: 'jup', includeCoingeckoCoin: true }),
        );
        const body = (await res.json()) as { coingeckoCoin: unknown };
        expect(body.coingeckoCoin).toBeNull();
        expect(coingeckoCalls).toBe(0);
    });

    it('hides stockInstrument when row is_active=false', async () => {
        const repo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            stockInstrumentByAssetId: {
                jup: {
                    asset_id: 'jup',
                    symbol: 'JUP',
                    normalized_symbol: 'jup',
                    name: null,
                    instrument_id: null,
                    dataset: null,
                    is_active: false,
                    source: 'clickhouse',
                    last_synced_at: NOW_MS,
                },
            },
        });
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({ assetId: 'jup', includeStockInstrument: true }),
        );
        const body = (await res.json()) as { stockInstrument: unknown };
        expect(body.stockInstrument).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: makeAssetsApiRepo() }));
        const cases = [
            JSON.stringify({}),
            JSON.stringify({ assetId: 123 }),
            JSON.stringify({ assetId: 'jup', includeVariants: 'no' }),
        ];
        for (const body of cases) {
            const res = await call(app, '/query/assetsApiLoadAssetBaseForApi', {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                },
                body,
            });
            expect(res.status).toBe(400);
        }
    });

    it('caps variantMarkets/fillQuality lookups at 250 mints', async () => {
        const manyVariants: AssetsApiVariantRow[] = Array.from({ length: 300 }, (_, i) => ({
            ...jupVariantRow,
            mint: `mint-${i}`,
            variant_id: `jup:solana:${i}`,
        }));
        let batchCalls = 0;
        let batchMintCount = 0;
        const repo: AssetsApiRepo = {
            ...makeAssetsApiRepo({
                assetsByAssetId: { jup: jupAssetRow },
                activeVariantsByAssetId: { jup: manyVariants },
            }),
            findVariantMarketsLatestByMints: async mints => {
                batchCalls++;
                batchMintCount = mints.length;
                return [];
            },
        };
        const app = createApp(deps({ repo: makeRepo(), assetsApiRepo: repo }));
        const res = await call(
            app,
            '/query/assetsApiLoadAssetBaseForApi',
            authed({
                assetId: 'jup',
                includeVariants: true,
                includeVariantMarkets: true,
            }),
        );
        const body = (await res.json()) as {
            variantMarkets: unknown[];
            variants: unknown[];
        };
        expect(body.variants).toHaveLength(300);
        expect(body.variantMarkets).toHaveLength(250);
        expect(batchCalls).toBe(1);
        expect(batchMintCount).toBe(250);
    });

    it('fillQuality batch returns the same row the singular would for each mint', async () => {
        const variantA: AssetsApiVariantRow = {
            ...jupVariantRow,
            mint: 'mint-A',
            variant_id: 'jup:solana:A',
        };
        const variantB: AssetsApiVariantRow = {
            ...jupVariantRow,
            mint: 'mint-B',
            variant_id: 'jup:solana:B',
        };
        const fqA: AssetsApiFillQualityRow = {
            ...jupFillQualityRow,
            mint: 'mint-A',
            execution_score: 0.7,
        };
        const fqB: AssetsApiFillQualityRow = {
            ...jupFillQualityRow,
            mint: 'mint-B',
            execution_score: 0.3,
        };
        const fillQualityByMint: Record<string, AssetsApiFillQualityRow> = {
            'mint-A': fqA,
            'mint-B': fqB,
        };
        const baseRepo = makeAssetsApiRepo({
            assetsByAssetId: { jup: jupAssetRow },
            activeVariantsByAssetId: { jup: [variantA, variantB] },
            fillQualityByMint,
        });
        const singularResults = await Promise.all(
            (['mint-A', 'mint-B', 'mint-missing'] as const).map(m => baseRepo.findVariantFillQualityLatestByMint(m)),
        );
        const batchResults = await baseRepo.findVariantFillQualityLatestByMints(['mint-A', 'mint-B', 'mint-missing']);
        const batchByMint = new Map(batchResults.map(r => [r.mint, r]));
        expect(batchByMint.get('mint-A') ?? null).toEqual(singularResults[0]);
        expect(batchByMint.get('mint-B') ?? null).toEqual(singularResults[1]);
        expect(batchByMint.get('mint-missing')).toBeUndefined();
        expect(singularResults[2]).toBeNull();
    });
});

const sampleStockInstrumentRow = (overrides: Partial<StockInstrumentRow> = {}): StockInstrumentRow => ({
    asset_id: 'aapl',
    symbol: 'AAPL',
    normalized_symbol: 'AAPL',
    name: 'Apple Inc.',
    instrument_id: 4242,
    dataset: 'nasdaq',
    is_active: true,
    source: 'clickhouse',
    last_synced_at: 1_000_000,
    ...overrides,
});

const sampleStockPriceRow = (overrides: Partial<StockPriceRow> = {}): StockPriceRow => ({
    asset_id: 'aapl',
    symbol: 'AAPL',
    normalized_symbol: 'AAPL',
    price_usd: 195.5,
    volume_24h_usd: 1_234_567,
    price_change_24h_percent: 0.42,
    shares_outstanding: null,
    shares_as_of: null,
    shares_last_fetched_at: null,
    as_of: 999_999,
    last_fetched_at: 1_234_500,
    source: 'clickhouse_stock',
    ...overrides,
});

describe('stockInstrumentsGetByAssetId', () => {
    it('maps row to camelCase result', async () => {
        const row = sampleStockInstrumentRow();
        const repo: StockReadsRepo = {
            ...emptyStockReadsRepo(),
            async findInstrumentByAssetId(id) {
                return id === 'aapl' ? row : null;
            },
        };
        const app = createApp(deps({ stockReadsRepo: repo }));
        const res = await call(app, '/query/stockInstrumentsGetByAssetId', authed({ assetId: 'aapl' }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assetId).toBe('aapl');
        expect(body.symbol).toBe('AAPL');
        expect(body.normalizedSymbol).toBe('AAPL');
        expect(body.name).toBe('Apple Inc.');
        expect(body.instrumentId).toBe(4242);
        expect(body.dataset).toBe('nasdaq');
        expect(body.isActive).toBe(true);
        expect(body.source).toBe('clickhouse');
        expect(body.lastSyncedAt).toBe(1_000_000);
    });

    it('returns null when missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockInstrumentsGetByAssetId', authed({ assetId: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('hides inactive unless includeInactive', async () => {
        const row = sampleStockInstrumentRow({ is_active: false });
        const repo: StockReadsRepo = {
            ...emptyStockReadsRepo(),
            async findInstrumentByAssetId() {
                return row;
            },
        };
        const app = createApp(deps({ stockReadsRepo: repo }));
        const hidden = await call(app, '/query/stockInstrumentsGetByAssetId', authed({ assetId: 'aapl' }));
        expect(await hidden.json()).toBeNull();
        const visible = await call(
            app,
            '/query/stockInstrumentsGetByAssetId',
            authed({ assetId: 'aapl', includeInactive: true }),
        );
        const body = (await visible.json()) as { isActive: boolean };
        expect(body.isActive).toBe(false);
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockInstrumentsGetByAssetId', authed({ assetId: 5 }));
        expect(res.status).toBe(400);
    });
});

describe('stockInstrumentsGetByAssetIds', () => {
    it('preserves order and emits null for missing', async () => {
        const row = sampleStockInstrumentRow();
        const repo: StockReadsRepo = {
            ...emptyStockReadsRepo(),
            async findInstrumentsByAssetIds(ids) {
                return ids.includes('aapl') ? [row] : [];
            },
        };
        const app = createApp(deps({ stockReadsRepo: repo }));
        const res = await call(app, '/query/stockInstrumentsGetByAssetIds', authed({ assetIds: ['aapl', 'missing'] }));
        const body = (await res.json()) as Array<{
            assetId: string;
            instrument: null | { assetId: string };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.assetId).toBe('aapl');
        expect(body[0]!.instrument?.assetId).toBe('aapl');
        expect(body[1]!.instrument).toBeNull();
    });

    it('returns 400 when assetIds is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockInstrumentsGetByAssetIds', authed({ assetIds: 'aapl' }));
        expect(res.status).toBe(400);
    });
});

describe('stockPricesGetLatestByAssetId', () => {
    it('maps row to camelCase result', async () => {
        const row = sampleStockPriceRow();
        const repo: StockReadsRepo = {
            ...emptyStockReadsRepo(),
            async findPriceByAssetId(id) {
                return id === 'aapl' ? row : null;
            },
        };
        const app = createApp(deps({ stockReadsRepo: repo }));
        const res = await call(app, '/query/stockPricesGetLatestByAssetId', authed({ assetId: 'aapl' }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.assetId).toBe('aapl');
        expect(body.symbol).toBe('AAPL');
        expect(body.priceUsd).toBe(195.5);
        expect(body.volume24hUsd).toBe(1_234_567);
        expect(body.priceChange24hPercent).toBe(0.42);
        expect(body.asOf).toBe(999_999);
        expect(body.lastFetchedAt).toBe(1_234_500);
        expect(body.source).toBe('clickhouse_stock');
    });

    it('returns null when missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockPricesGetLatestByAssetId', authed({ assetId: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockPricesGetLatestByAssetId', authed({ assetId: 7 }));
        expect(res.status).toBe(400);
    });
});

describe('stockPricesGetLatestByAssetIds', () => {
    it('preserves order and emits null for missing', async () => {
        const row = sampleStockPriceRow();
        const repo: StockReadsRepo = {
            ...emptyStockReadsRepo(),
            async findPricesByAssetIds(ids) {
                return ids.includes('aapl') ? [row] : [];
            },
        };
        const app = createApp(deps({ stockReadsRepo: repo }));
        const res = await call(app, '/query/stockPricesGetLatestByAssetIds', authed({ assetIds: ['aapl', 'missing'] }));
        const body = (await res.json()) as Array<{
            assetId: string;
            snapshot: null | { assetId: string };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.assetId).toBe('aapl');
        expect(body[0]!.snapshot?.assetId).toBe('aapl');
        expect(body[1]!.snapshot).toBeNull();
    });

    it('returns 400 when assetIds is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockPricesGetLatestByAssetIds', authed({ assetIds: 'aapl' }));
        expect(res.status).toBe(400);
    });
});

const sampleCandleRow = (overrides: Partial<OhlcvCandleRow> = {}): OhlcvCandleRow => ({
    time: 1_700_000_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1000,
    ...overrides,
});

describe('ohlcvList', () => {
    it('returns mapped candles for valid args', async () => {
        const candle = sampleCandleRow();
        let captured: {
            address?: string;
            interval?: string;
            from?: number;
            to?: number;
            limit?: number;
        } = {};
        const repo: OhlcvReadsRepo = {
            ...emptyOhlcvReadsRepo(),
            async listByAddressAndInterval(address, interval, from, to, limit) {
                captured = { address, interval, from, to, limit };
                return [candle];
            },
        };
        const app = createApp(deps({ ohlcvReadsRepo: repo }));
        const res = await call(
            app,
            '/query/ohlcvList',
            authed({
                address: 'mintA',
                interval: '1H',
                from: 100,
                to: 200,
                limit: 50,
            }),
        );
        const body = (await res.json()) as OhlcvCandleRow[];
        expect(body.length).toBe(1);
        expect(body[0]!.time).toBe(1_700_000_000);
        expect(body[0]!.close).toBe(1.5);
        expect(captured.address).toBe('mintA');
        expect(captured.interval).toBe('1H');
        expect(captured.from).toBe(100);
        expect(captured.to).toBe(200);
        expect(captured.limit).toBe(50);
    });

    it('returns 400 on invalid interval', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/ohlcvList', authed({ address: 'mintA', interval: '99h' }));
        expect(res.status).toBe(400);
    });
});

describe('ohlcvBounds', () => {
    it('returns min/max time from repo', async () => {
        const repo: OhlcvReadsRepo = {
            ...emptyOhlcvReadsRepo(),
            async getBoundsByAddressAndInterval() {
                return { minTime: 100, maxTime: 500 };
            },
        };
        const app = createApp(deps({ ohlcvReadsRepo: repo }));
        const res = await call(app, '/query/ohlcvBounds', authed({ address: 'mintA', interval: '1D' }));
        expect(await res.json()).toEqual({ minTime: 100, maxTime: 500 });
    });

    it('returns 400 on missing address', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/ohlcvBounds', authed({ interval: '1D' }));
        expect(res.status).toBe(400);
    });
});

describe('stockOhlcvList', () => {
    it('returns mapped candles for valid args', async () => {
        const candle = sampleCandleRow();
        const captured: { assetId: string | null } = { assetId: null };
        const repo: OhlcvReadsRepo = {
            ...emptyOhlcvReadsRepo(),
            async listByAssetIdAndInterval(assetId) {
                captured.assetId = assetId;
                return [candle];
            },
        };
        const app = createApp(deps({ ohlcvReadsRepo: repo }));
        const res = await call(
            app,
            '/query/stockOhlcvList',
            authed({
                assetId: 'aapl',
                interval: '1H',
                from: 0,
                to: 1_000_000_000,
            }),
        );
        const body = (await res.json()) as OhlcvCandleRow[];
        expect(body.length).toBe(1);
        expect(captured.assetId).toBe('aapl');
    });

    it('returns [] when assetId blank', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockOhlcvList', authed({ assetId: '   ', interval: '1H' }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 on invalid interval', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/stockOhlcvList', authed({ assetId: 'aapl', interval: 'bad' }));
        expect(res.status).toBe(400);
    });
});

interface CoingeckoReadsMockData {
    coinsByCoinId?: Record<string, CoingeckoCoinRow>;
    searchById?: Record<string, CoingeckoCoinSearchRow[]>;
    searchBySymbol?: Record<string, CoingeckoCoinSearchRow[]>;
    searchByName?: Record<string, CoingeckoCoinSearchRow[]>;
    ohlcvByCoinAndInterval?: Record<string, CoingeckoOhlcvRow[]>;
    priceByCoinId?: Record<string, CoingeckoPriceLatestRow>;
    tickersByCoinId?: Record<string, CoingeckoTickersLatestRow>;
}

function emptyCoingeckoReadsRepo(): CoingeckoReadsRepo {
    return makeCoingeckoReadsRepo();
}

function makeCoingeckoReadsRepo(data: CoingeckoReadsMockData = {}): CoingeckoReadsRepo {
    return {
        async findCoinByCoinId(coinId) {
            return data.coinsByCoinId?.[coinId] ?? null;
        },
        async searchCoinsById(query, limit) {
            return (data.searchById?.[query] ?? []).slice(0, limit);
        },
        async searchCoinsBySymbol(query, limit) {
            return (data.searchBySymbol?.[query] ?? []).slice(0, limit);
        },
        async searchCoinsByName(query, limit) {
            return (data.searchByName?.[query] ?? []).slice(0, limit);
        },
        async listOhlcv(coinId, interval, fromTime, toTime, limit) {
            const key = `${coinId}::${interval}`;
            const candles = data.ohlcvByCoinAndInterval?.[key] ?? [];
            return candles.filter(c => c.time >= fromTime && c.time <= toTime).slice(0, limit);
        },
        async findPriceLatestByCoinId(coinId) {
            return data.priceByCoinId?.[coinId] ?? null;
        },
        async findPriceLatestByCoinIds(coinIds) {
            const out: CoingeckoPriceLatestRow[] = [];
            for (const id of coinIds) {
                const row = data.priceByCoinId?.[id];
                if (row) out.push(row);
            }
            return out;
        },
        async findTickersLatestByCoinId(coinId) {
            return data.tickersByCoinId?.[coinId] ?? null;
        },
    };
}

const COIN_CREATED_AT = new Date('2026-01-01T00:00:00Z');

function sampleCoinRow(overrides: Partial<CoingeckoCoinRow> = {}): CoingeckoCoinRow {
    return {
        id: 'pk_solana',
        coin_id: 'solana',
        symbol: 'sol',
        name: 'Solana',
        platforms: { solana: '' },
        last_synced_at: 1_700_000_000_000,
        coin: { image: { thumb: 'thumb.png', large: 'large.png' } },
        last_metadata_fetched_at: 1_700_000_000_000,
        created_at: COIN_CREATED_AT,
        ...overrides,
    };
}

describe('coingeckoReadsGetCoinById', () => {
    it('returns the mapped coin row', async () => {
        const repo = makeCoingeckoReadsRepo({
            coinsByCoinId: { solana: sampleCoinRow() },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(app, '/query/coingeckoReadsGetCoinById', authed({ id: 'solana' }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            id: string;
            symbol: string;
            name: string;
            _creationTime: number;
            lastSyncedAt: number;
            lastMetadataFetchedAt?: number;
            coin?: Record<string, unknown>;
        };
        expect(body.id).toBe('solana');
        expect(body.symbol).toBe('sol');
        expect(body.name).toBe('Solana');
        expect(body._creationTime).toBe(COIN_CREATED_AT.getTime());
        expect(body.lastSyncedAt).toBe(1_700_000_000_000);
        expect(body.lastMetadataFetchedAt).toBe(1_700_000_000_000);
        expect(body.coin).toBeDefined();
    });

    it('returns null when row is missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsGetCoinById', authed({ id: 'missing' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('returns null for whitespace-only id', async () => {
        const repo = makeCoingeckoReadsRepo({
            coinsByCoinId: { solana: sampleCoinRow() },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(app, '/query/coingeckoReadsGetCoinById', authed({ id: '   ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });

    it('rejects non-string id with 400', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsGetCoinById', authed({ id: 123 }));
        expect(res.status).toBe(400);
    });
});

describe('coingeckoReadsSearchCoins', () => {
    const solanaSearch: CoingeckoCoinSearchRow = {
        coin_id: 'solana',
        symbol: 'sol',
        name: 'Solana',
        platforms: { solana: '' },
        coin: { image: { large: 'sol.png' } },
    };
    const solflareSearch: CoingeckoCoinSearchRow = {
        coin_id: 'solflare',
        symbol: 'sf',
        name: 'Solflare',
        platforms: { solana: '' },
        coin: null,
    };

    it('returns prioritized id, symbol, name matches, deduplicated', async () => {
        const repo = makeCoingeckoReadsRepo({
            searchById: { sol: [solanaSearch] },
            searchBySymbol: { sol: [solanaSearch, solflareSearch] },
            searchByName: { sol: [solflareSearch] },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(app, '/query/coingeckoReadsSearchCoins', authed({ query: 'sol' }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{ id: string }>;
        expect(body.map(r => r.id)).toEqual(['solana', 'solflare']);
    });

    it('returns [] for empty trimmed query', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsSearchCoins', authed({ query: '   ' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it('rejects non-string query with 400', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsSearchCoins', authed({ query: 42 }));
        expect(res.status).toBe(400);
    });
});

describe('coingeckoReadsListOhlcv', () => {
    const candles: CoingeckoOhlcvRow[] = [
        { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
        { time: 2000, open: 1.5, high: 2.5, low: 1.4, close: 2, volume: 150 },
        { time: 3000, open: 2, high: 3, low: 1.9, close: 2.5, volume: 200 },
    ];

    it('returns filtered candles', async () => {
        const repo = makeCoingeckoReadsRepo({
            ohlcvByCoinAndInterval: { 'solana::1H': candles },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(
            app,
            '/query/coingeckoReadsListOhlcv',
            authed({ coinId: 'solana', interval: '1H', from: 1500, to: 3500 }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as CoingeckoOhlcvRow[];
        expect(body).toHaveLength(2);
        expect(body[0]!.time).toBe(2000);
    });

    it('returns [] when coinId is empty', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsListOhlcv', authed({ coinId: '  ', interval: '1H' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it('rejects invalid interval with 400', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsListOhlcv', authed({ coinId: 'solana', interval: '10s' }));
        expect(res.status).toBe(400);
    });
});

describe('coingeckoReadsGetPriceLatestByCoinId', () => {
    const priceRow: CoingeckoPriceLatestRow = {
        coin_id: 'solana',
        price_usd: 100,
        market_cap_usd: 50_000_000_000,
        volume_24h_usd: 2_000_000_000,
        price_change_24h_percent: 1.5,
        provider_last_updated_at: 1_700_000_000,
        last_fetched_at: 1_700_000_000_000,
    };

    it('returns the mapped snapshot', async () => {
        const repo = makeCoingeckoReadsRepo({
            priceByCoinId: { solana: priceRow },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(app, '/query/coingeckoReadsGetPriceLatestByCoinId', authed({ coinId: 'solana' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            coinId: 'solana',
            priceUsd: 100,
            marketCapUsd: 50_000_000_000,
            volume24hUsd: 2_000_000_000,
            priceChange24hPercent: 1.5,
            providerLastUpdatedAt: 1_700_000_000,
            lastFetchedAt: 1_700_000_000_000,
        });
    });

    it('returns null when not found', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsGetPriceLatestByCoinId', authed({ coinId: 'missing' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });
});

describe('coingeckoReadsGetPriceLatestByCoinIds', () => {
    const solRow: CoingeckoPriceLatestRow = {
        coin_id: 'solana',
        price_usd: 100,
        market_cap_usd: null,
        volume_24h_usd: null,
        price_change_24h_percent: null,
        provider_last_updated_at: null,
        last_fetched_at: 1_700_000_000_000,
    };

    it('returns entries for requested IDs with null for missing', async () => {
        const repo = makeCoingeckoReadsRepo({
            priceByCoinId: { solana: solRow },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(
            app,
            '/query/coingeckoReadsGetPriceLatestByCoinIds',
            authed({ coinIds: ['solana', 'jupiter-exchange-solana'] }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{
            coinId: string;
            snapshot: unknown;
        }>;
        expect(body).toEqual([
            {
                coinId: 'solana',
                snapshot: {
                    coinId: 'solana',
                    priceUsd: 100,
                    marketCapUsd: null,
                    volume24hUsd: null,
                    priceChange24hPercent: null,
                    providerLastUpdatedAt: null,
                    lastFetchedAt: 1_700_000_000_000,
                },
            },
            { coinId: 'jupiter-exchange-solana', snapshot: null },
        ]);
    });

    it('rejects more than 50 coinIds with 400', async () => {
        const app = createApp(deps());
        const tooMany: string[] = [];
        for (let i = 0; i < 60; i++) tooMany.push(`coin-${i}`);
        const res = await call(app, '/query/coingeckoReadsGetPriceLatestByCoinIds', authed({ coinIds: tooMany }));
        expect(res.status).toBe(400);
    });
});

describe('coingeckoReadsGetTickersLatestByCoinId', () => {
    const tickerRow: CoingeckoTickersLatestRow = {
        coin_id: 'solana',
        name: 'Solana',
        tickers: [{ base: 'SOL', target: 'USDT' }],
        total: 12,
        last_fetched_at: 1_700_000_000_000,
    };

    it('returns the mapped tickers doc', async () => {
        const repo = makeCoingeckoReadsRepo({
            tickersByCoinId: { solana: tickerRow },
        });
        const app = createApp(deps({ coingeckoReadsRepo: repo }));
        const res = await call(app, '/query/coingeckoReadsGetTickersLatestByCoinId', authed({ coinId: 'solana' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            coinId: 'solana',
            tickers: [{ base: 'SOL', target: 'USDT' }],
            lastFetchedAt: 1_700_000_000_000,
            name: 'Solana',
            total: 12,
        });
    });

    it('returns null when no row exists', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/coingeckoReadsGetTickersLatestByCoinId', authed({ coinId: 'missing' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toBeNull();
    });
});

function emptyTokensReadsRepo(): TokensReadsRepo {
    return {
        async findTokenByAddress() {
            return null;
        },
        async findTokensByAddresses() {
            return [];
        },
        async searchTokensBySymbol() {
            return [];
        },
        async searchTokensByName() {
            return [];
        },
        async findTokenMarketsLatestByMint() {
            return null;
        },
        async findTokenMarketsLatestByMints() {
            return [];
        },
        async findTokenDescriptionSummaryByAddress() {
            return null;
        },
    };
}

function emptyTrendingReadsRepo(): TrendingReadsRepo {
    return {
        async listTrending() {
            return [];
        },
        async listFreshTrending() {
            return [];
        },
    };
}

function emptyFillQualityReadsRepo(): FillQualityReadsRepo {
    return {
        async findLatestByMints() {
            return [];
        },
    };
}

function emptyAssetCollectionsReadsRepo(): AssetCollectionsReadsRepo {
    return {
        async listMembersBySlug() {
            return [];
        },
        async listMemberMintsBySlug() {
            return [];
        },
        async getSummariesBySlugs() {
            return [];
        },
    };
}

function emptyTokenListsReadsRepo(): TokenListsReadsRepo {
    return {
        async listPublished() {
            return [];
        },
        async getBySlug() {
            return null;
        },
        async listMembersBySlug() {
            return [];
        },
        async listSlugsByMints() {
            return [];
        },
    };
}

function emptyTokenListsMutationsDeps(): TokenListsMutationsDeps {
    return {
        repo: {
            async getListBySlug() {
                return null;
            },
            async insertList() {
                throw new Error('not implemented');
            },
            async updateList() {
                throw new Error('not implemented');
            },
            async deleteList() {
                throw new Error('not implemented');
            },
            async upsertMember() {},
            async removeMember() {
                return false;
            },
            async hasActiveVariantForMint() {
                return false;
            },
            async hasTokenForAddress() {
                return false;
            },
        },
        fetchTokenOverview: async () => null,
        now: () => 0,
    };
}

const sampleTokenRow = (overrides: Partial<TokenRow> = {}): TokenRow => ({
    id: 't1',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logo_uri: 'https://example.test/usdc.png',
    coingecko_id: 'usd-coin',
    description: null,
    website: null,
    twitter: null,
    discord: null,
    telegram: null,
    reddit: null,
    github: null,
    price: 1.0,
    price_change_24h_percent: 0.01,
    price_change_1h_percent: null,
    volume_24h_usd: 1234567,
    liquidity: 9999,
    market_cap: 5000000,
    last_fetched_at: 1_700_000_000_000,
    created_at: NOW,
    ...overrides,
});

describe('tokensGetByAddress', () => {
    it('returns mapped token doc', async () => {
        const row = sampleTokenRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenByAddress(addr) {
                return addr === row.address ? row : null;
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokensGetByAddress', authed({ address: row.address }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.address).toBe(row.address);
        expect(body.symbol).toBe('USDC');
        expect(body.decimals).toBe(6);
        expect(body.logoUri).toBe('https://example.test/usdc.png');
        expect(body.price).toBe(1.0);
        expect(body.lastFetchedAt).toBe(1_700_000_000_000);
    });

    it('returns null when missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokensGetByAddress', authed({ address: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokensGetByAddress', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ address: 5 }),
        });
        expect(res.status).toBe(400);
    });
});

describe('tokensSearchTokens', () => {
    it('exact-matches a valid Solana mint', async () => {
        const row = sampleTokenRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenByAddress(addr) {
                return addr === row.address ? row : null;
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokensSearchTokens', authed({ query: row.address }));
        const body = (await res.json()) as Array<{ address: string }>;
        expect(body.length).toBe(1);
        expect(body[0]!.address).toBe(row.address);
    });

    it('merges symbol + name matches, deduped, capped by limit', async () => {
        const usdc = sampleTokenRow();
        const usdt = sampleTokenRow({
            id: 't2',
            address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            symbol: 'USDT',
            name: 'Tether',
        });
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async searchTokensBySymbol() {
                return [usdc];
            },
            async searchTokensByName() {
                return [usdc, usdt];
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokensSearchTokens', authed({ query: 'usd', limit: 5 }));
        const body = (await res.json()) as Array<{ address: string }>;
        expect(body.length).toBe(2);
        expect(body[0]!.address).toBe(usdc.address);
        expect(body[1]!.address).toBe(usdt.address);
    });

    it('returns [] for empty query', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokensSearchTokens', authed({ query: '   ' }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 when query is missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokensSearchTokens', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(res.status).toBe(400);
    });
});

describe('tokensGetSearchTokensByAddresses', () => {
    it('returns one entry per input preserving order, sets hasMarket flag', async () => {
        const row = sampleTokenRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokensByAddresses(addrs) {
                return addrs.includes(row.address) ? [row] : [];
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(
            app,
            '/query/tokensGetSearchTokensByAddresses',
            authed({ addresses: [row.address, 'absent'] }),
        );
        const body = (await res.json()) as Array<{
            address: string;
            token: { symbol: string } | null;
            hasMarket: boolean;
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.address).toBe(row.address);
        expect(body[0]!.token?.symbol).toBe('USDC');
        expect(body[0]!.hasMarket).toBe(true);
        expect(body[1]!.token).toBeNull();
        expect(body[1]!.hasMarket).toBe(false);
    });

    it('returns 400 when addresses is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokensGetSearchTokensByAddresses', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ addresses: 'a' }),
        });
        expect(res.status).toBe(400);
    });
});

const sampleTokenMarketsRow = (overrides: Partial<TokenMarketsLatestRow> = {}): TokenMarketsLatestRow => ({
    mint: 'mintA',
    source: 'birdeye',
    markets: [
        { address: 'pool1', liquidity: 100, volume24h: 50, price: 1.0 },
        { address: 'pool2', liquidity: 200, volume24h: 80, price: 1.01 },
    ],
    total: 2,
    last_fetched_at: 1_700_000_000_000,
    ...overrides,
});

describe('tokenMarketsGetLatestByMint', () => {
    it('returns mapped doc with filtered markets', async () => {
        const row = sampleTokenMarketsRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenMarketsLatestByMint(mint) {
                return mint === row.mint ? row : null;
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokenMarketsGetLatestByMint', authed({ mint: 'mintA' }));
        const body = (await res.json()) as {
            mint: string;
            source: string;
            total: number;
            markets: unknown[];
        };
        expect(body.mint).toBe('mintA');
        expect(body.source).toBe('birdeye');
        expect(body.total).toBe(2);
        expect(body.markets).toHaveLength(2);
    });

    it('returns null on miss', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenMarketsGetLatestByMint', authed({ mint: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenMarketsGetLatestByMint', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mint: 5 }),
        });
        expect(res.status).toBe(400);
    });
});

describe('tokenMarketsGetLatestByMints', () => {
    it('returns one entry per input mint preserving order', async () => {
        const row = sampleTokenMarketsRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenMarketsLatestByMints(mints) {
                return mints.includes('mintA') ? [row] : [];
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokenMarketsGetLatestByMints', authed({ mints: ['mintA', 'absent'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            doc: null | { mint: string };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.doc?.mint).toBe('mintA');
        expect(body[1]!.doc).toBeNull();
    });

    it('returns 400 when too many mints', async () => {
        const app = createApp(deps());
        const mints = Array.from({ length: 51 }, (_, i) => `m${i}`);
        const res = await call(app, '/query/tokenMarketsGetLatestByMints', authed({ mints }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when mints is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenMarketsGetLatestByMints', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mints: 'a' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('tokenMarketsGetTopMarketsByMints', () => {
    it('selects the highest-liquidity priced market per mint', async () => {
        const row = sampleTokenMarketsRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenMarketsLatestByMints() {
                return [row];
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokenMarketsGetTopMarketsByMints', authed({ mints: ['mintA'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            topMarket: { address: string } | null;
            total: number | null;
        }>;
        expect(body.length).toBe(1);
        expect(body[0]!.topMarket?.address).toBe('pool2');
        expect(body[0]!.total).toBe(2);
    });

    it('returns null entries when mint missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenMarketsGetTopMarketsByMints', authed({ mints: ['absent'] }));
        const body = (await res.json()) as Array<{
            mint: string;
            topMarket: unknown;
            total: number | null;
            lastFetchedAt: number | null;
        }>;
        expect(body[0]!.topMarket).toBeNull();
        expect(body[0]!.total).toBeNull();
        expect(body[0]!.lastFetchedAt).toBeNull();
    });

    it('returns 400 when too many mints', async () => {
        const app = createApp(deps());
        const mints = Array.from({ length: 51 }, (_, i) => `m${i}`);
        const res = await call(app, '/query/tokenMarketsGetTopMarketsByMints', authed({ mints }));
        expect(res.status).toBe(400);
    });
});

const sampleSummaryRow = (overrides: Partial<TokenDescriptionSummaryRow> = {}): TokenDescriptionSummaryRow => ({
    id: 's1',
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    summary: 'A USD stablecoin.',
    source_hash: 'h1',
    model: 'gpt-4',
    prompt_version: 1,
    generated_at: 1_700_000_000_000,
    created_at: NOW,
    ...overrides,
});

describe('tokenDescriptionSummariesGetByAddress', () => {
    it('returns mapped summary doc', async () => {
        const row = sampleSummaryRow();
        const repo: TokensReadsRepo = {
            ...emptyTokensReadsRepo(),
            async findTokenDescriptionSummaryByAddress(addr) {
                return addr === row.address ? row : null;
            },
        };
        const app = createApp(deps({ tokensReadsRepo: repo }));
        const res = await call(app, '/query/tokenDescriptionSummariesGetByAddress', authed({ address: row.address }));
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.address).toBe(row.address);
        expect(body.summary).toBe('A USD stablecoin.');
        expect(body.sourceHash).toBe('h1');
        expect(body.promptVersion).toBe(1);
        expect(body.generatedAt).toBe(1_700_000_000_000);
    });

    it('returns null when missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenDescriptionSummariesGetByAddress', authed({ address: 'absent' }));
        expect(await res.json()).toBeNull();
    });

    it('returns 400 on invalid args', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/tokenDescriptionSummariesGetByAddress', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

const sampleTrendingRow = (overrides: Partial<TrendingMarketRow> = {}): TrendingMarketRow => ({
    mint: 'mintA',
    asset_id: 'asset1',
    variant_id: 'v1',
    category: 'crypto',
    symbol: 'AAA',
    name: 'Asset A',
    decimals: 6,
    logo_uri: null,
    source: 'clickhouse_trades',
    scoring_version: 'solana-direct-stable-v1',
    price: 1.0,
    volume_5m_usd: 1,
    volume_15m_usd: 2,
    volume_1h_usd: 3,
    volume_6h_usd: 4,
    volume_24h_usd: 5,
    trade_5m: 1,
    trade_15m: 1,
    trade_1h: 1,
    trade_6h: 1,
    trade_24h: 1,
    unique_wallet_5m: 1,
    unique_wallet_1h: 1,
    unique_wallet_24h: 1,
    price_change_1h_percent: null,
    price_change_24h_percent: null,
    trending_score: 100,
    rank: 1,
    category_rank: 1,
    last_trade_at: null,
    as_of: 1_700_000_000_000,
    last_computed_at: 1_700_000_000_000,
    ...overrides,
});

describe('trendingMarketsList', () => {
    it('returns sorted page with totals + asOf', async () => {
        const r1 = sampleTrendingRow({ mint: 'a', rank: 2, category_rank: 2 });
        const r2 = sampleTrendingRow({ mint: 'b', rank: 1, category_rank: 1 });
        const repo: TrendingReadsRepo = {
            ...emptyTrendingReadsRepo(),
            async listTrending() {
                return [r1, r2];
            },
        };
        const app = createApp(deps({ trendingReadsRepo: repo }));
        const res = await call(app, '/query/trendingMarketsList', authed({ limit: 10 }));
        const body = (await res.json()) as {
            rows: Array<{ mint: string; rank: number }>;
            total: number;
            asOf: number | null;
            scoringVersion: string;
        };
        expect(body.total).toBe(2);
        expect(body.rows[0]!.mint).toBe('b');
        expect(body.rows[1]!.mint).toBe('a');
        expect(body.asOf).toBe(1_700_000_000_000);
        expect(body.scoringVersion).toBe('solana-direct-stable-v1');
    });

    it('filters by category and sorts by categoryRank', async () => {
        const c1 = sampleTrendingRow({
            mint: 'c1',
            category: 'crypto',
            rank: 5,
            category_rank: 1,
        });
        const c2 = sampleTrendingRow({
            mint: 'c2',
            category: 'crypto',
            rank: 1,
            category_rank: 2,
        });
        let receivedCategory: string | null = '';
        const repo: TrendingReadsRepo = {
            ...emptyTrendingReadsRepo(),
            async listTrending(category) {
                receivedCategory = category;
                return [c1, c2];
            },
        };
        const app = createApp(deps({ trendingReadsRepo: repo }));
        const res = await call(app, '/query/trendingMarketsList', authed({ category: 'crypto' }));
        const body = (await res.json()) as { rows: Array<{ mint: string }> };
        expect(receivedCategory).toBe('crypto');
        expect(body.rows[0]!.mint).toBe('c1');
        expect(body.rows[1]!.mint).toBe('c2');
    });

    it('returns 400 on invalid category', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/trendingMarketsList', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ category: 'bogus' }),
        });
        expect(res.status).toBe(400);
    });
});

const sampleFreshTrendingRow = (overrides: Partial<FreshTrendingMarketRow> = {}): FreshTrendingMarketRow => ({
    mint: 'mintA',
    asset_id: 'asset1',
    variant_id: 'v1',
    category: 'crypto',
    symbol: 'AAA',
    name: 'Asset A',
    decimals: 6,
    logo_uri: null,
    source: 'birdeye',
    metrics_source: null,
    scoring_version: 'birdeye-selected-fresh-v1',
    price: 1.0,
    liquidity: 1000,
    volume_5m_usd: null,
    volume_15m_usd: null,
    volume_1h_usd: null,
    volume_6h_usd: null,
    volume_24h_usd: 50,
    trade_5m: null,
    trade_15m: null,
    trade_1h: null,
    trade_6h: null,
    trade_24h: null,
    unique_wallet_5m: null,
    unique_wallet_1h: null,
    unique_wallet_24h: null,
    price_change_1h_percent: null,
    price_change_24h_percent: null,
    last_trade_at: null,
    as_of: null,
    last_fetched_at: 1_700_000_000_000,
    trending_score: 50,
    rank: 1,
    category_rank: 1,
    last_computed_at: 1_700_000_000_000,
    ...overrides,
});

describe('freshTrendingMarketsList', () => {
    it('returns mapped rows with asOf from last_fetched_at', async () => {
        const row = sampleFreshTrendingRow();
        const repo: TrendingReadsRepo = {
            ...emptyTrendingReadsRepo(),
            async listFreshTrending() {
                return [row];
            },
        };
        const app = createApp(deps({ trendingReadsRepo: repo }));
        const res = await call(app, '/query/freshTrendingMarketsList', authed({}));
        const body = (await res.json()) as {
            rows: Array<{ mint: string; source: string }>;
            total: number;
            asOf: number | null;
            scoringVersion: string;
        };
        expect(body.total).toBe(1);
        expect(body.rows[0]!.mint).toBe('mintA');
        expect(body.rows[0]!.source).toBe('birdeye');
        expect(body.asOf).toBe(1_700_000_000_000);
        expect(body.scoringVersion).toBe('birdeye-selected-fresh-v1');
    });

    it('returns 400 on non-number limit', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/freshTrendingMarketsList', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ limit: 'big' }),
        });
        expect(res.status).toBe(400);
    });
});

const sampleFillQualityRow = (overrides: Partial<FillQualityRow> = {}): FillQualityRow => ({
    mint: 'mintA',
    source: 'clickhouse_fill_quality',
    range_identifier: '24h',
    horizon: '5s',
    quote_mint: 'USDC',
    volume_24h_usd: 100,
    trade_24h: 10,
    bot_volume_24h_usd: 10,
    bot_trade_24h: 1,
    bot_volume_ratio: 0.1,
    fee_24h_usd: 1,
    fee_bps: 10,
    flow_source_count: 2,
    markout_pnl_24h_usd: null,
    markout_count: null,
    markout_bps: null,
    execution_score: 5.5,
    is_eligible_for_primary: true,
    as_of: 1_700_000_000_000,
    last_computed_at: 1_700_000_000_000,
    ...overrides,
});

describe('variantFillQualityGetLatestByMints', () => {
    it('returns mapped doc per mint with nulls preserved', async () => {
        const row = sampleFillQualityRow();
        const repo: FillQualityReadsRepo = {
            async findLatestByMints(mints) {
                return mints.includes('mintA') ? [row] : [];
            },
        };
        const app = createApp(deps({ fillQualityReadsRepo: repo }));
        const res = await call(
            app,
            '/query/variantFillQualityGetLatestByMints',
            authed({ mints: ['mintA', 'absent'] }),
        );
        const body = (await res.json()) as Array<{
            mint: string;
            fillQuality: null | {
                mint: string;
                executionScore: number;
                isEligibleForPrimary: boolean;
            };
        }>;
        expect(body.length).toBe(2);
        expect(body[0]!.fillQuality?.executionScore).toBe(5.5);
        expect(body[0]!.fillQuality?.isEligibleForPrimary).toBe(true);
        expect(body[1]!.fillQuality).toBeNull();
    });

    it('returns [] for empty mints', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/variantFillQualityGetLatestByMints', authed({ mints: [] }));
        expect(await res.json()).toEqual([]);
    });

    it('returns 400 when mints is not an array', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/variantFillQualityGetLatestByMints', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ mints: 'm' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('assetCollectionsGetMembers', () => {
    it('returns asset ids in rank order', async () => {
        const rows: AssetCollectionMemberRow[] = [{ asset_id: 'a' }, { asset_id: 'b' }];
        let receivedSlug = '';
        let receivedLimit = 0;
        const repo: AssetCollectionsReadsRepo = {
            async listMembersBySlug(slug, limit) {
                receivedSlug = slug;
                receivedLimit = limit;
                return rows;
            },
            async listMemberMintsBySlug() {
                return [];
            },
            async getSummariesBySlugs() {
                return [];
            },
        };
        const app = createApp(deps({ assetCollectionsReadsRepo: repo }));
        const res = await call(app, '/query/assetCollectionsGetMembers', authed({ slug: 'memes', limit: 100 }));
        const body = (await res.json()) as string[];
        expect(body).toEqual(['a', 'b']);
        expect(receivedSlug).toBe('memes');
        expect(receivedLimit).toBe(100);
    });

    it('returns [] for empty slug', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetCollectionsGetMembers', authed({ slug: '   ' }));
        expect(await res.json()).toEqual([]);
    });

    it('normalizes legacy slug aliases (xstocks → etfs, stables → currencies)', async () => {
        const slugsSeen: string[] = [];
        const repo: AssetCollectionsReadsRepo = {
            async listMembersBySlug(slug) {
                slugsSeen.push(slug);
                return [{ asset_id: 'a' }];
            },
            async listMemberMintsBySlug() {
                return [];
            },
            async getSummariesBySlugs() {
                return [];
            },
        };
        const app = createApp(deps({ assetCollectionsReadsRepo: repo }));
        await call(app, '/query/assetCollectionsGetMembers', authed({ slug: 'xstocks' }));
        await call(app, '/query/assetCollectionsGetMembers', authed({ slug: 'stables' }));
        await call(app, '/query/assetCollectionsGetMembers', authed({ slug: 'majors' }));
        expect(slugsSeen).toEqual(['etfs', 'currencies', 'majors']);
    });

    it('returns 400 when slug is missing', async () => {
        const app = createApp(deps());
        const res = await call(app, '/query/assetCollectionsGetMembers', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
            },
            body: '{}',
        });
        expect(res.status).toBe(400);
    });
});

describe('admin mutations dispatch', () => {
    const ADMIN_MINT = 'AdminTestMint111111111111111111111111111111';

    function makeAdminActionsDeps(): AdminActionsDeps {
        const repo: AdminActionsRepo = {
            async findAssetByAssetId() {
                return null;
            },
            async listCollectionSlugsForAssetId() {
                return [];
            },
            async findVariantByMint() {
                return null;
            },
            async listVariantIdsByAssetId() {
                return [];
            },
            async createVariantWithMarket() {},
            async getNextCategoryRank() {
                return 0;
            },
            async upsertAssetCollectionMember() {},
            async upsertAssetCollectionTitle() {},
            async clearDeletedRefs() {
                return 0;
            },
        };
        // The cron/misc/seed deps are never reached by these dispatch tests
        // (they all fail during auth or validation first).
        return {
            adminAllowlist: {
                clerkUserIds: new Set(['user_admin']),
                emails: new Set<string>(),
            },
            repo,
            seedRepo: {} as AdminActionsDeps['seedRepo'],
            cron: {} as AdminActionsDeps['cron'],
            misc: {} as AdminActionsDeps['misc'],
            now: () => Date.now(),
        };
    }

    const ADMIN_MUTATIONS = [
        'adminCheckVariantMintForCanonical',
        'adminAddCheckedVariant',
        'adminSeedAsset',
        'adminRefreshChartData',
    ];

    it('404s the admin mutations when adminActionsDeps is not wired', async () => {
        const app = createApp(deps());
        for (const name of ADMIN_MUTATIONS) {
            const res = await call(app, `/mutation/${name}`, authed({ mint: ADMIN_MINT }));
            expect(res.status).toBe(404);
        }
    });

    it('returns 401 identity_required without an x-tokens-identity header', async () => {
        const app = createApp(deps({ adminActionsDeps: makeAdminActionsDeps() }));
        for (const name of ADMIN_MUTATIONS) {
            const res = await call(app, `/mutation/${name}`, authed({ mint: ADMIN_MINT }));
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({ error: 'identity_required' });
        }
    });

    it('returns 403 unauthorized for a non-admin identity', async () => {
        const app = createApp(deps({ adminActionsDeps: makeAdminActionsDeps() }));
        for (const name of ADMIN_MUTATIONS) {
            const res = await call(app, `/mutation/${name}`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer tok',
                    'content-type': 'application/json',
                    'x-tokens-identity': encodeIdentity({
                        clerkUserId: 'user_mortal',
                    }),
                },
                body: JSON.stringify({ mint: ADMIN_MINT }),
            });
            expect(res.status).toBe(403);
            expect(await res.json()).toEqual({ error: 'unauthorized' });
        }
    });

    it('returns 400 invalid_args with the message for admin validation failures', async () => {
        const app = createApp(deps({ adminActionsDeps: makeAdminActionsDeps() }));
        const res = await call(app, '/mutation/adminRefreshChartData', {
            method: 'POST',
            headers: {
                authorization: 'Bearer tok',
                'content-type': 'application/json',
                'x-tokens-identity': encodeIdentity({
                    clerkUserId: 'user_admin',
                }),
            },
            body: JSON.stringify({ mint: 'not-a-mint' }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            error: 'invalid_args',
            message: 'Not a valid Solana mint address',
        });
    });
});
