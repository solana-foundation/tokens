import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { isValidBearerToken } from '@tokens/cloudrun-shutdown';

import {
    getByAssetId,
    getByAssetIds,
    IdentityRequiredError,
    InvalidArgsError,
    UnauthorizedError,
    listActiveWithCoinGeckoIds,
    listByCategory,
    resolveAssetRef,
    resolveAssetRefForApi,
    search,
    type AssetsRepo,
    type CallerIdentity,
} from './handlers/assets';
import { loadAssetBaseForApi, type AssetsApiRepo } from './handlers/assetsApi';
import { assetsApiCuratedPrefetchForApi } from './handlers/assetsApiCuratedPrefetch';
import { assetsApiSearchPrefetchForApi } from './handlers/assetsApiSearchPrefetch';
import { setAssetDescriptionByAssetId } from './handlers/assetsMutations';
import {
    listDeletedRefs,
    type AssetDeletionTombstonesRepo,
} from './handlers/assetDeletionTombstones';
import {
    listActive as sanctumListActive,
    resolveRef as sanctumResolveRef,
    type SanctumLstsRepo,
} from './handlers/sanctumLsts';
import {
    getLatestByAssetId as assetMarketsGetLatestByAssetId,
    getLatestByAssetIds as assetMarketsGetLatestByAssetIds,
    type AssetMarketsRepo,
} from './handlers/assetMarkets';
import {
    getLatestByMints as variantMarketsGetLatestByMints,
    type VariantMarketsRepo,
} from './handlers/variantMarkets';
import {
    getByMint as assetVariantsGetByMint,
    getSolanaDefaultVariantsViewForApi,
    listByAssetIds as assetVariantsListByAssetIds,
    listByMints as assetVariantsListByMints,
    listSolanaVariantsForApi,
    type AssetVariantsRepo,
} from './handlers/assetVariants';
import {
    getSearchTokensByAddresses as tokensGetSearchTokensByAddresses,
    getTokenByAddress as tokensGetByAddress,
    getTokenDescriptionSummaryByAddress as tokensGetDescriptionSummaryByAddress,
    getTokenMarketsLatestByMint as tokenMarketsGetLatestByMint,
    getTokenMarketsLatestByMints as tokenMarketsGetLatestByMints,
    getTopMarketsByMints as tokenMarketsGetTopMarketsByMints,
    searchTokens as tokensSearchTokens,
    type TokensReadsRepo,
} from './handlers/tokensReads';
import {
    listFreshTrending as freshTrendingMarketsList,
    listTrending as trendingMarketsList,
    type TrendingReadsRepo,
} from './handlers/trendingReads';
import {
    getLatestByMints as variantFillQualityGetLatestByMints,
    type FillQualityReadsRepo,
} from './handlers/fillQualityReads';
import {
    getMembers as assetCollectionsGetMembers,
    type AssetCollectionsReadsRepo,
} from './handlers/assetCollectionsReads';
import {
    getCoinById as coingeckoReadsGetCoinById,
    getPriceLatestByCoinId as coingeckoReadsGetPriceLatestByCoinId,
    getPriceLatestByCoinIds as coingeckoReadsGetPriceLatestByCoinIds,
    getTickersLatestByCoinId as coingeckoReadsGetTickersLatestByCoinId,
    listOhlcv as coingeckoReadsListOhlcv,
    searchCoins as coingeckoReadsSearchCoins,
    type CoingeckoReadsRepo,
} from './handlers/coingeckoReads';
import {
    getInstrumentByAssetId as stockGetInstrumentByAssetId,
    getInstrumentsByAssetIds as stockGetInstrumentsByAssetIds,
    getPriceLatestByAssetId as stockGetPriceLatestByAssetId,
    getPriceLatestByAssetIds as stockGetPriceLatestByAssetIds,
    type StockReadsRepo,
} from './handlers/stockReads';
import {
    getOhlcvBounds,
    listOhlcv,
    listStockOhlcv,
    type OhlcvReadsRepo,
} from './handlers/ohlcvReads';
import {
    InvalidArgsError as CronInvalidArgsError,
    createApiUsagePartitions,
    pruneApiRequestEvents,
    refreshCuratedAssetMarkets,
    refreshCuratedAssetRisk,
    refreshCuratedOhlcv,
    refreshCuratedVariantMarkets,
    refreshStaleVariantMarkets,
    rollupActiveApiUsage,
    syncSanctumLsts,
    type CronDeps,
    type CronResult,
} from './handlers/crons';
import { coingeckoJobs } from './handlers/crons.coingecko';
import { clickhouseJobs, type ClickhouseCronDeps } from './handlers/crons.clickhouse';
import { miscJobs, type MiscCronDeps, type MiscJobHandler } from './handlers/crons.misc';
import {
    assetVariantsJobs,
    type AssetVariantsCronDeps,
    type AssetVariantsJobHandler,
} from './handlers/crons.assetVariants';
import { seedJobs, type SeedCronDeps, type SeedJobHandler } from './handlers/crons.seed';
import { trendingJobs, type TrendingCronDeps, type TrendingJobHandler } from './handlers/crons.trending';
import {
    clickhouseExtrasJobs,
    type ClickhouseExtrasCronDeps,
    type ClickhouseExtrasJobHandler,
} from './handlers/crons.clickhouse.extras';
import {
    adminAddCheckedVariant,
    adminCheckVariantMintForCanonical,
    adminRefreshChartData,
    adminSeedAsset,
    type AdminActionsDeps,
} from './handlers/adminActions';
import {
    cacheWarmRequest,
    cacheWarmRequestAssetRisk,
    cacheWarmRequestCoingeckoOhlcv,
    cacheWarmRequestCoingeckoTickers,
    cacheWarmRequestCoinMetadata,
    cacheWarmRequestCoinPrice,
    cacheWarmRequestCuratedListWarm,
    cacheWarmRequestMintsWarm,
    cacheWarmRequestRegistrySeed,
    cacheWarmRequestStockOhlcv,
    cacheWarmRequestStockPrice,
    cacheWarmSetAssetLogoUrl,
    type CacheWarmDeps,
} from './handlers/cacheWarm';
import { OidcAuthError, parseBearer, type VerifyOidc } from './oidc';

export interface ServerDeps {
    repo: AssetsRepo;
    assetsApiRepo: AssetsApiRepo;
    deletionTombstonesRepo: AssetDeletionTombstonesRepo;
    sanctumLstsRepo: SanctumLstsRepo;
    assetMarketsRepo: AssetMarketsRepo;
    variantMarketsRepo: VariantMarketsRepo;
    assetVariantsRepo: AssetVariantsRepo;
    tokensReadsRepo: TokensReadsRepo;
    trendingReadsRepo: TrendingReadsRepo;
    fillQualityReadsRepo: FillQualityReadsRepo;
    assetCollectionsReadsRepo: AssetCollectionsReadsRepo;
    coingeckoReadsRepo: CoingeckoReadsRepo;
    stockReadsRepo: StockReadsRepo;
    ohlcvReadsRepo: OhlcvReadsRepo;
    authToken: string;
    cronDeps?: CronDeps & Partial<ClickhouseCronDeps>;
    miscCronDeps?: MiscCronDeps;
    assetVariantsCronDeps?: AssetVariantsCronDeps;
    seedCronDeps?: SeedCronDeps;
    trendingCronDeps?: TrendingCronDeps;
    clickhouseExtrasCronDeps?: ClickhouseExtrasCronDeps;
    cacheWarmDeps?: CacheWarmDeps;
    adminActionsDeps?: AdminActionsDeps;
    verifyOidc?: VerifyOidc;
}

type Handler = (args: unknown, identity: CallerIdentity | null) => Promise<unknown>;
type JobHandler = (deps: CronDeps & ClickhouseCronDeps, args: unknown) => Promise<CronResult>;

/**
 * SECURITY: trusted-on-arrival by design. This header is a base64 JSON blob
 * decoded WITHOUT cryptographic verification — the caller identity is whatever
 * the header claims. The trust model relies on (1) this service only being
 * reachable via the upstream API proxy (`apps/api`), which authenticates the
 * real user and populates this header itself, and (2) the shared bearer token
 * (`authToken`) gating every RPC route. If either invariant breaks, anyone can
 * impersonate any user by forging this header.
 */
const IDENTITY_HEADER = 'x-tokens-identity';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const DEAD_CONNECTION_CODES = new Set(['CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'ECONNRESET']);

function isDeadConnectionError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: unknown; errno?: unknown }).code ?? (err as { errno?: unknown }).errno;
    return typeof code === 'string' && DEAD_CONNECTION_CODES.has(code);
}

function decodeIdentityHeader(raw: string | undefined): CallerIdentity | null | InvalidArgsError {
    if (!raw) return null;
    if (raw.length % 4 !== 0 || !BASE64_RE.test(raw)) {
        return new InvalidArgsError('x-tokens-identity is not valid base64');
    }
    const json = Buffer.from(raw, 'base64').toString('utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return new InvalidArgsError('x-tokens-identity payload is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return new InvalidArgsError('x-tokens-identity payload must be an object');
    }
    const p = parsed as { clerkUserId?: unknown; projectId?: unknown };
    if (typeof p.clerkUserId !== 'string' || p.clerkUserId.length === 0) {
        return new InvalidArgsError('x-tokens-identity.clerkUserId must be a non-empty string');
    }
    if (p.projectId !== undefined && typeof p.projectId !== 'string') {
        return new InvalidArgsError('x-tokens-identity.projectId must be a string when present');
    }
    const out: CallerIdentity = { clerkUserId: p.clerkUserId };
    if (typeof p.projectId === 'string') out.projectId = p.projectId;
    return out;
}

export function createApp(deps: ServerDeps) {
    const app = new Hono();

    app.use('*', compress());

    const queries: Record<string, Handler> = Object.create(null);
    queries.getByAssetId = args => getByAssetId(deps.repo, args);
    queries.getByAssetIds = args => getByAssetIds(deps.repo, args);
    queries.search = args => search(deps.repo, args);
    queries.resolveAssetRef = args => resolveAssetRef(deps.repo, args);
    queries.resolveAssetRefForApi = args => resolveAssetRefForApi(deps.repo, args);
    queries.listActiveWithCoinGeckoIds = args => listActiveWithCoinGeckoIds(deps.repo, args);
    queries.listByCategory = args => listByCategory(deps.repo, args);
    queries.assetsApiLoadAssetBaseForApi = args => loadAssetBaseForApi(deps.assetsApiRepo, args);
    queries.assetsApiCuratedPrefetchForApi = args =>
        assetsApiCuratedPrefetchForApi(
            {
                assetsRepo: deps.repo,
                assetCollectionsReadsRepo: deps.assetCollectionsReadsRepo,
                assetVariantsRepo: deps.assetVariantsRepo,
                variantMarketsRepo: deps.variantMarketsRepo,
                fillQualityReadsRepo: deps.fillQualityReadsRepo,
                assetMarketsRepo: deps.assetMarketsRepo,
                sanctumLstsRepo: deps.sanctumLstsRepo,
                deletionTombstonesRepo: deps.deletionTombstonesRepo,
                stockReadsRepo: deps.stockReadsRepo,
                coingeckoReadsRepo: deps.coingeckoReadsRepo,
                tokensReadsRepo: deps.tokensReadsRepo,
            },
            args,
        );
    queries.assetsApiSearchPrefetchForApi = args =>
        assetsApiSearchPrefetchForApi(
            {
                assetsRepo: deps.repo,
                assetVariantsRepo: deps.assetVariantsRepo,
                sanctumLstsRepo: deps.sanctumLstsRepo,
                tokensReadsRepo: deps.tokensReadsRepo,
                variantMarketsRepo: deps.variantMarketsRepo,
                fillQualityReadsRepo: deps.fillQualityReadsRepo,
                assetMarketsRepo: deps.assetMarketsRepo,
                stockReadsRepo: deps.stockReadsRepo,
                coingeckoReadsRepo: deps.coingeckoReadsRepo,
            },
            args,
        );
    queries.listDeletedRefs = args => listDeletedRefs(deps.deletionTombstonesRepo, args);
    queries.sanctumListActive = args => sanctumListActive(deps.sanctumLstsRepo, args);
    queries.sanctumResolveRef = args => sanctumResolveRef(deps.sanctumLstsRepo, args);
    queries.assetMarketsGetLatestByAssetId = args =>
        assetMarketsGetLatestByAssetId(deps.assetMarketsRepo, args);
    queries.assetMarketsGetLatestByAssetIds = args =>
        assetMarketsGetLatestByAssetIds(deps.assetMarketsRepo, args);
    queries.variantMarketsGetLatestByMints = args =>
        variantMarketsGetLatestByMints(deps.variantMarketsRepo, args);
    queries.assetVariantsGetByMint = args => assetVariantsGetByMint(deps.assetVariantsRepo, args);
    queries.assetVariantsListByAssetIds = args =>
        assetVariantsListByAssetIds(deps.assetVariantsRepo, args);
    queries.assetVariantsListByMints = args => assetVariantsListByMints(deps.assetVariantsRepo, args);
    queries.assetVariantsGetSolanaDefaultVariantsViewForApi = args =>
        getSolanaDefaultVariantsViewForApi(deps.assetVariantsRepo, args);
    queries.assetVariantsListSolanaVariantsForApi = args =>
        listSolanaVariantsForApi(deps.assetVariantsRepo, args);
    queries.tokensGetByAddress = args => tokensGetByAddress(deps.tokensReadsRepo, args);
    queries.tokensSearchTokens = args => tokensSearchTokens(deps.tokensReadsRepo, args);
    queries.tokensGetSearchTokensByAddresses = args =>
        tokensGetSearchTokensByAddresses(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetLatestByMint = args =>
        tokenMarketsGetLatestByMint(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetLatestByMints = args =>
        tokenMarketsGetLatestByMints(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetTopMarketsByMints = args =>
        tokenMarketsGetTopMarketsByMints(deps.tokensReadsRepo, args);
    queries.tokenDescriptionSummariesGetByAddress = args =>
        tokensGetDescriptionSummaryByAddress(deps.tokensReadsRepo, args);
    queries.trendingMarketsList = args => trendingMarketsList(deps.trendingReadsRepo, args);
    queries.freshTrendingMarketsList = args => freshTrendingMarketsList(deps.trendingReadsRepo, args);
    queries.variantFillQualityGetLatestByMints = args =>
        variantFillQualityGetLatestByMints(deps.fillQualityReadsRepo, args);
    queries.assetCollectionsGetMembers = args =>
        assetCollectionsGetMembers(deps.assetCollectionsReadsRepo, args);
    queries.coingeckoReadsGetCoinById = args => coingeckoReadsGetCoinById(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsSearchCoins = args => coingeckoReadsSearchCoins(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsListOhlcv = args => coingeckoReadsListOhlcv(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetPriceLatestByCoinId = args =>
        coingeckoReadsGetPriceLatestByCoinId(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetPriceLatestByCoinIds = args =>
        coingeckoReadsGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetTickersLatestByCoinId = args =>
        coingeckoReadsGetTickersLatestByCoinId(deps.coingeckoReadsRepo, args);
    queries.stockInstrumentsGetByAssetId = args =>
        stockGetInstrumentByAssetId(deps.stockReadsRepo, args);
    queries.stockInstrumentsGetByAssetIds = args =>
        stockGetInstrumentsByAssetIds(deps.stockReadsRepo, args);
    queries.stockPricesGetLatestByAssetId = args =>
        stockGetPriceLatestByAssetId(deps.stockReadsRepo, args);
    queries.stockPricesGetLatestByAssetIds = args =>
        stockGetPriceLatestByAssetIds(deps.stockReadsRepo, args);
    queries.stockOhlcvList = args => listStockOhlcv(deps.ohlcvReadsRepo, args);
    queries.ohlcvBounds = args => getOhlcvBounds(deps.ohlcvReadsRepo, args);
    queries.ohlcvList = args => listOhlcv(deps.ohlcvReadsRepo, args);

    const mutations: Record<string, Handler> = Object.create(null);
    mutations.setAssetDescriptionByAssetId = (args, identity) =>
        setAssetDescriptionByAssetId(deps.repo, args, identity);

    // Warm-on-miss cache warming (port of convex/cacheWarm.ts). Registered only
    // when the cron deps are wired; otherwise these names 404 like any unknown
    // mutation. Auth is the shared bearer token checked by the dispatcher.
    const cacheWarmDeps = deps.cacheWarmDeps;
    if (cacheWarmDeps) {
        mutations.cacheWarmRequest = args => cacheWarmRequest(cacheWarmDeps, args);
        mutations.cacheWarmRequestCoingeckoOhlcv = args => cacheWarmRequestCoingeckoOhlcv(cacheWarmDeps, args);
        mutations.cacheWarmRequestCoinPrice = args => cacheWarmRequestCoinPrice(cacheWarmDeps, args);
        mutations.cacheWarmRequestCoinMetadata = args => cacheWarmRequestCoinMetadata(cacheWarmDeps, args);
        mutations.cacheWarmRequestCoingeckoTickers = args => cacheWarmRequestCoingeckoTickers(cacheWarmDeps, args);
        mutations.cacheWarmRequestStockPrice = args => cacheWarmRequestStockPrice(cacheWarmDeps, args);
        mutations.cacheWarmRequestStockOhlcv = args => cacheWarmRequestStockOhlcv(cacheWarmDeps, args);
        mutations.cacheWarmRequestAssetRisk = args => cacheWarmRequestAssetRisk(cacheWarmDeps, args);
        mutations.cacheWarmRequestMintsWarm = args => cacheWarmRequestMintsWarm(cacheWarmDeps, args);
        mutations.cacheWarmRequestCuratedListWarm = args => cacheWarmRequestCuratedListWarm(cacheWarmDeps, args);
        mutations.cacheWarmRequestRegistrySeed = args => cacheWarmRequestRegistrySeed(cacheWarmDeps, args);
        mutations.cacheWarmSetAssetLogoUrl = args => cacheWarmSetAssetLogoUrl(cacheWarmDeps, args);
    }

    // Admin curated-token actions (port of convex/adminCuratedTokensActions.ts),
    // called by the apps/admin proxy with a Clerk-verified x-tokens-identity
    // header. Registered only when the cron deps are wired; every handler
    // enforces the TOKENS_ADMIN_CLERK_USER_IDS allowlist (401/403).
    const adminActionsDeps = deps.adminActionsDeps;
    if (adminActionsDeps) {
        mutations.adminCheckVariantMintForCanonical = (args, identity) =>
            adminCheckVariantMintForCanonical(adminActionsDeps, args, identity);
        mutations.adminAddCheckedVariant = (args, identity) =>
            adminAddCheckedVariant(adminActionsDeps, args, identity);
        mutations.adminSeedAsset = (args, identity) => adminSeedAsset(adminActionsDeps, args, identity);
        mutations.adminRefreshChartData = (args, identity) =>
            adminRefreshChartData(adminActionsDeps, args, identity);
    }

    app.get('/health', c => c.json({ ok: true }));

    const dispatch = (kind: 'query' | 'mutation', table: Record<string, Handler>) =>
        async (c: Context) => {
            if (!isValidBearerToken(c.req.header('authorization'), deps.authToken)) {
                return c.json({ error: 'unauthorized' }, 401);
            }
            const identityResult = decodeIdentityHeader(c.req.header(IDENTITY_HEADER));
            if (identityResult instanceof InvalidArgsError) {
                return c.json({ error: 'invalid_args', message: identityResult.message }, 400);
            }
            const name = c.req.param('name') ?? '';
            if (!name || !Object.hasOwn(table, name)) {
                return c.json({ error: `unknown ${kind}: ${name}` }, 404);
            }
            const handler = table[name]!;
            const args: unknown = await c.req.json().catch(() => ({}));
            try {
                try {
                    return c.json(await handler(args, identityResult));
                } catch (err) {
                    if (kind !== 'query' || !isDeadConnectionError(err)) throw err;
                    console.warn(`[cloudrun-assets] query ${name} retrying after dead connection`);
                    return c.json(await handler(args, identityResult));
                }
            } catch (err) {
                if (err instanceof InvalidArgsError || err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                if (err instanceof IdentityRequiredError) {
                    return c.json({ error: 'identity_required' }, 401);
                }
                if (err instanceof UnauthorizedError) {
                    return c.json({ error: 'unauthorized' }, 403);
                }
                console.error(`[cloudrun-assets] ${kind} ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        };

    app.post('/query/:name', dispatch('query', queries));
    app.post('/mutation/:name', dispatch('mutation', mutations));

    const jobs: Record<string, JobHandler> = Object.create(null);
    jobs['refresh-asset-variant-markets'] = refreshCuratedVariantMarkets;
    jobs['refresh-asset-aggregates'] = refreshCuratedAssetMarkets;
    jobs['refresh-stale-asset-variant-markets'] = refreshStaleVariantMarkets;
    jobs['sync-sanctum-lsts'] = syncSanctumLsts;
    jobs['refresh-curated-asset-risk'] = refreshCuratedAssetRisk;
    jobs['rollup-active-api-usage'] = rollupActiveApiUsage;
    jobs['prune-api-request-events'] = pruneApiRequestEvents;
    jobs['create-api-usage-partitions'] = createApiUsagePartitions;
    jobs['refresh-curated-ohlcv-15m'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1h'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-4h'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1d'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1w'] = refreshCuratedOhlcv;
    Object.assign(jobs, coingeckoJobs);
    Object.assign(jobs, clickhouseJobs as Record<string, JobHandler>);

    const miscJobsTable: Record<string, MiscJobHandler> = { ...miscJobs };
    const assetVariantsJobsTable: Record<string, AssetVariantsJobHandler> = { ...assetVariantsJobs };
    const seedJobsTable: Record<string, SeedJobHandler> = { ...seedJobs };
    const trendingJobsTable: Record<string, TrendingJobHandler> = { ...trendingJobs };
    const clickhouseExtrasJobsTable: Record<string, ClickhouseExtrasJobHandler> = { ...clickhouseExtrasJobs };

    app.post('/jobs/:name', async (c: Context) => {
        const cronDeps = deps.cronDeps;
        const miscCronDeps = deps.miscCronDeps;
        const assetVariantsCronDeps = deps.assetVariantsCronDeps;
        const seedCronDeps = deps.seedCronDeps;
        const trendingCronDeps = deps.trendingCronDeps;
        const clickhouseExtrasCronDeps = deps.clickhouseExtrasCronDeps;
        const verifyOidc = deps.verifyOidc;
        if (!cronDeps || !verifyOidc) {
            return c.json({ error: 'jobs_disabled' }, 404);
        }
        const token = parseBearer(c.req.header('authorization'));
        if (!token) {
            return c.json({ error: 'unauthorized' }, 401);
        }
        try {
            await verifyOidc(token);
        } catch (err) {
            if (err instanceof OidcAuthError) {
                return c.json({ error: 'unauthorized' }, 401);
            }
            console.error('[cloudrun-assets] verifyOidc threw', err);
            return c.json({ error: 'unauthorized' }, 401);
        }
        const name = c.req.param('name') ?? '';
        const args: unknown = await c.req.json().catch(() => ({}));
        if (Object.hasOwn(jobs, name)) {
            if (Object.hasOwn(clickhouseJobs, name) && (!cronDeps.clickhouseRepo || !cronDeps.clickhouse || !cronDeps.env)) {
                return c.json({ error: 'clickhouse_jobs_disabled' }, 404);
            }
            const handler = jobs[name]!;
            try {
                return c.json(await handler(cronDeps as CronDeps & ClickhouseCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        if (Object.hasOwn(miscJobsTable, name)) {
            if (!miscCronDeps) {
                return c.json({ error: 'jobs_disabled' }, 404);
            }
            const handler = miscJobsTable[name]!;
            try {
                return c.json(await handler(miscCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        if (Object.hasOwn(assetVariantsJobsTable, name)) {
            if (!assetVariantsCronDeps) {
                return c.json({ error: 'jobs_disabled' }, 404);
            }
            const handler = assetVariantsJobsTable[name]!;
            try {
                return c.json(await handler(assetVariantsCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        if (Object.hasOwn(seedJobsTable, name)) {
            if (!seedCronDeps) {
                return c.json({ error: 'jobs_disabled' }, 404);
            }
            const handler = seedJobsTable[name]!;
            try {
                return c.json(await handler(seedCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        if (Object.hasOwn(trendingJobsTable, name)) {
            if (!trendingCronDeps) {
                return c.json({ error: 'jobs_disabled' }, 404);
            }
            const handler = trendingJobsTable[name]!;
            try {
                return c.json(await handler(trendingCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        if (Object.hasOwn(clickhouseExtrasJobsTable, name)) {
            if (!clickhouseExtrasCronDeps) {
                return c.json({ error: 'jobs_disabled' }, 404);
            }
            const handler = clickhouseExtrasJobsTable[name]!;
            try {
                return c.json(await handler(clickhouseExtrasCronDeps, args));
            } catch (err) {
                if (err instanceof CronInvalidArgsError) {
                    return c.json({ error: 'invalid_args', message: err.message }, 400);
                }
                console.error(`[cloudrun-assets] job ${name} threw`, err);
                return c.json({ error: 'handler_error' }, 500);
            }
        }
        return c.json({ error: `unknown job: ${name}` }, 404);
    });

    return app;
}
