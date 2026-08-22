import { Hono, type Context } from 'hono';
import { BadRequestError } from '@tokens/effect';
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
import { listDeletedRefs, type AssetDeletionTombstonesRepo } from './handlers/assetDeletionTombstones';
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
import { getLatestByMints as variantMarketsGetLatestByMints, type VariantMarketsRepo } from './handlers/variantMarkets';
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
    getMemberMints as assetCollectionsGetMemberMints,
    getSummaries as assetCollectionsGetSummaries,
    type AssetCollectionsReadsRepo,
} from './handlers/assetCollectionsReads';
import {
    getBySlug as tokenListsGetBySlug,
    getMembers as tokenListsGetMembers,
    getSlugsByMints as tokenListsGetSlugsByMints,
    listPublished as tokenListsListPublished,
    type TokenListsReadsRepo,
} from './handlers/tokenListsReads';
import {
    addMembersBatch as tokenListsAddMembersBatch,
    archiveList as tokenListsArchiveList,
    createList as tokenListsCreateList,
    deleteList as tokenListsDeleteList,
    removeMember as tokenListsRemoveMember,
    updateList as tokenListsUpdateList,
    upsertMember as tokenListsUpsertMember,
    type TokenListsMutationsDeps,
} from './handlers/tokenListsMutations';
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
import { getOhlcvBounds, listOhlcv, listStockOhlcv, type OhlcvReadsRepo } from './handlers/ohlcvReads';
import { getLatestByMints as prestocksGetLatestByMints, type PrestocksReadsRepo } from './handlers/prestocksReads';
import {
    InvalidArgsError as CronInvalidArgsError,
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
import { clickhouseJobs, type ClickhouseCronDeps, type ClickhouseJobHandler } from './handlers/crons.clickhouse';
import { miscJobs, type MiscCronDeps, type MiscJobHandler } from './handlers/crons.misc';
import {
    assetVariantsJobs,
    type AssetVariantsCronDeps,
    type AssetVariantsJobHandler,
} from './handlers/crons.assetVariants';
import { seedJobs, type SeedCronDeps, type SeedJobHandler } from './handlers/crons.seed';
import { prestocksJobs, type PrestocksCronDeps, type PrestocksJobHandler } from './handlers/crons.prestocks';
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
import { runAtomicReadWithRetry, structuredDatabaseFailure } from './transientDb';

export type ServiceRole = 'api' | 'worker' | 'hybrid';

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
    tokenListsReadsRepo: TokenListsReadsRepo;
    tokenListsMutationsDeps: TokenListsMutationsDeps;
    coingeckoReadsRepo: CoingeckoReadsRepo;
    stockReadsRepo: StockReadsRepo;
    ohlcvReadsRepo: OhlcvReadsRepo;
    prestocksReadsRepo: PrestocksReadsRepo;
    authToken: string;
    /** API serves RPC routes; worker serves Cloud Scheduler jobs only. */
    serviceRole?: ServiceRole;
    /** Production injects a SELECT 1 check for the Cloud Run startup probe. */
    checkDatabase?: () => Promise<void>;
    /** Test seam; production leaves the database-aware startup timeout at 2.8s. */
    startupDatabaseTimeoutMs?: number;
    cronDeps?: CronDeps;
    clickhouseCronDeps?: CronDeps & ClickhouseCronDeps;
    miscCronDeps?: MiscCronDeps;
    assetVariantsCronDeps?: AssetVariantsCronDeps;
    seedCronDeps?: SeedCronDeps;
    trendingCronDeps?: TrendingCronDeps;
    clickhouseExtrasCronDeps?: ClickhouseExtrasCronDeps;
    prestocksCronDeps?: PrestocksCronDeps;
    cacheWarmDeps?: CacheWarmDeps;
    adminActionsDeps?: AdminActionsDeps;
    verifyOidc?: VerifyOidc;
    /**
     * When set, RPC routes also accept a Google OIDC ID token (audience/SA
     * pinned to the Vercel admin invoker) as the bearer, alongside the shared
     * authToken used by apps/api.
     */
    rpcVerifyOidc?: VerifyOidc;
}

export async function isAuthorizedRpcCaller(
    authHeader: string | undefined,
    deps: Pick<ServerDeps, 'authToken' | 'rpcVerifyOidc'>,
): Promise<boolean> {
    if (isValidBearerToken(authHeader, deps.authToken)) return true;
    if (!deps.rpcVerifyOidc) return false;
    const token = parseBearer(authHeader);
    if (!token) return false;
    try {
        await deps.rpcVerifyOidc(token);
        return true;
    } catch {
        return false;
    }
}

type Handler = (args: unknown, identity: CallerIdentity | null) => Promise<unknown>;
type JobHandler = (deps: CronDeps, args: unknown) => Promise<CronResult>;

// Explicit allowlist: every entry performs one idempotent repository read.
// Wide/multi-step handlers are intentionally absent so a failed connection
// never replays an entire fan-out.
const ATOMIC_RETRY_QUERY_NAMES = new Set([
    'getByAssetId',
    'getByAssetIds',
    'listActiveWithCoinGeckoIds',
    'listByCategory',
    'listDeletedRefs',
    'sanctumListActive',
    'assetMarketsGetLatestByAssetId',
    'assetMarketsGetLatestByAssetIds',
    'variantMarketsGetLatestByMints',
    'assetVariantsListByAssetIds',
    'assetVariantsGetSolanaDefaultVariantsViewForApi',
    'tokensGetByAddress',
    'tokensGetSearchTokensByAddresses',
    'tokenMarketsGetLatestByMint',
    'tokenMarketsGetLatestByMints',
    'tokenMarketsGetTopMarketsByMints',
    'tokenDescriptionSummariesGetByAddress',
    'trendingMarketsList',
    'freshTrendingMarketsList',
    'variantFillQualityGetLatestByMints',
    'assetCollectionsGetMembers',
    'assetCollectionsGetMemberMints',
    'assetCollectionsGetSummaries',
    'tokenListsList',
    'tokenListsGetBySlug',
    'tokenListsGetMembers',
    'tokenListsGetSlugsByMints',
    'coingeckoReadsGetCoinById',
    'coingeckoReadsListOhlcv',
    'coingeckoReadsGetPriceLatestByCoinId',
    'coingeckoReadsGetPriceLatestByCoinIds',
    'coingeckoReadsGetTickersLatestByCoinId',
    'stockInstrumentsGetByAssetId',
    'stockInstrumentsGetByAssetIds',
    'stockPricesGetLatestByAssetId',
    'stockPricesGetLatestByAssetIds',
    'prestocksGetLatestByMints',
    'stockOhlcvList',
    'ohlcvBounds',
    'ohlcvList',
]);

/**
 * `ok: false` means total failure (work attempted, none succeeded) — return
 * 500 so Cloud Scheduler counts the run as failed and retries per its policy.
 */
function cronJobResponse(c: Context, result: CronResult) {
    return c.json(result, result.ok === false ? 500 : 200);
}

/**
 * Shared error mapping for job handlers: invalid args (either the legacy
 * CronInvalidArgsError or @tokens/effect's BadRequestError from decodeJobArgs)
 * map to 400; everything else logs the full error (stack preserved) and 500s.
 */
function jobErrorResponse(c: Context, name: string, err: unknown) {
    if (err instanceof CronInvalidArgsError || err instanceof BadRequestError) {
        return c.json({ error: 'invalid_args', message: err.message }, 400);
    }
    console.error(`[cloudrun-assets] job ${name} threw`, err);
    return c.json({ error: 'handler_error' }, 500);
}

async function checkStartupDatabase(check: () => Promise<void>, timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(
            () => reject(Object.assign(new Error('startup database check timed out'), { code: 'ETIMEDOUT' })),
            timeoutMs,
        );
    });
    try {
        await Promise.race([check(), timedOut]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

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
    const p = parsed as {
        clerkUserId?: unknown;
        projectId?: unknown;
        email?: unknown;
    };
    if (typeof p.clerkUserId !== 'string' || p.clerkUserId.length === 0) {
        return new InvalidArgsError('x-tokens-identity.clerkUserId must be a non-empty string');
    }
    if (p.projectId !== undefined && typeof p.projectId !== 'string') {
        return new InvalidArgsError('x-tokens-identity.projectId must be a string when present');
    }
    if (p.email !== undefined && typeof p.email !== 'string') {
        return new InvalidArgsError('x-tokens-identity.email must be a string when present');
    }
    const out: CallerIdentity = { clerkUserId: p.clerkUserId };
    if (typeof p.projectId === 'string') out.projectId = p.projectId;
    if (typeof p.email === 'string' && p.email.trim()) out.email = p.email.trim();
    return out;
}

export function createApp(deps: ServerDeps) {
    const app = new Hono();
    // `hybrid` preserves the direct createApp test seam. The executable always
    // injects an explicit api/worker role in deployed environments.
    const serviceRole = deps.serviceRole ?? 'hybrid';

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
    queries.assetMarketsGetLatestByAssetId = args => assetMarketsGetLatestByAssetId(deps.assetMarketsRepo, args);
    queries.assetMarketsGetLatestByAssetIds = args => assetMarketsGetLatestByAssetIds(deps.assetMarketsRepo, args);
    queries.variantMarketsGetLatestByMints = args => variantMarketsGetLatestByMints(deps.variantMarketsRepo, args);
    queries.assetVariantsGetByMint = args => assetVariantsGetByMint(deps.assetVariantsRepo, args);
    queries.assetVariantsListByAssetIds = args => assetVariantsListByAssetIds(deps.assetVariantsRepo, args);
    queries.assetVariantsListByMints = args => assetVariantsListByMints(deps.assetVariantsRepo, args);
    queries.assetVariantsGetSolanaDefaultVariantsViewForApi = args =>
        getSolanaDefaultVariantsViewForApi(deps.assetVariantsRepo, args);
    queries.assetVariantsListSolanaVariantsForApi = args => listSolanaVariantsForApi(deps.assetVariantsRepo, args);
    queries.tokensGetByAddress = args => tokensGetByAddress(deps.tokensReadsRepo, args);
    queries.tokensSearchTokens = args => tokensSearchTokens(deps.tokensReadsRepo, args);
    queries.tokensGetSearchTokensByAddresses = args => tokensGetSearchTokensByAddresses(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetLatestByMint = args => tokenMarketsGetLatestByMint(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetLatestByMints = args => tokenMarketsGetLatestByMints(deps.tokensReadsRepo, args);
    queries.tokenMarketsGetTopMarketsByMints = args => tokenMarketsGetTopMarketsByMints(deps.tokensReadsRepo, args);
    queries.tokenDescriptionSummariesGetByAddress = args =>
        tokensGetDescriptionSummaryByAddress(deps.tokensReadsRepo, args);
    queries.trendingMarketsList = args => trendingMarketsList(deps.trendingReadsRepo, args);
    queries.freshTrendingMarketsList = args => freshTrendingMarketsList(deps.trendingReadsRepo, args);
    queries.variantFillQualityGetLatestByMints = args =>
        variantFillQualityGetLatestByMints(deps.fillQualityReadsRepo, args);
    queries.assetCollectionsGetMembers = args => assetCollectionsGetMembers(deps.assetCollectionsReadsRepo, args);
    queries.assetCollectionsGetMemberMints = args =>
        assetCollectionsGetMemberMints(deps.assetCollectionsReadsRepo, args);
    queries.assetCollectionsGetSummaries = args => assetCollectionsGetSummaries(deps.assetCollectionsReadsRepo, args);
    queries.tokenListsList = args => tokenListsListPublished(deps.tokenListsReadsRepo, args);
    queries.tokenListsGetBySlug = args => tokenListsGetBySlug(deps.tokenListsReadsRepo, args);
    queries.tokenListsGetMembers = args => tokenListsGetMembers(deps.tokenListsReadsRepo, args);
    queries.tokenListsGetSlugsByMints = args => tokenListsGetSlugsByMints(deps.tokenListsReadsRepo, args);
    queries.coingeckoReadsGetCoinById = args => coingeckoReadsGetCoinById(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsSearchCoins = args => coingeckoReadsSearchCoins(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsListOhlcv = args => coingeckoReadsListOhlcv(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetPriceLatestByCoinId = args =>
        coingeckoReadsGetPriceLatestByCoinId(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetPriceLatestByCoinIds = args =>
        coingeckoReadsGetPriceLatestByCoinIds(deps.coingeckoReadsRepo, args);
    queries.coingeckoReadsGetTickersLatestByCoinId = args =>
        coingeckoReadsGetTickersLatestByCoinId(deps.coingeckoReadsRepo, args);
    queries.stockInstrumentsGetByAssetId = args => stockGetInstrumentByAssetId(deps.stockReadsRepo, args);
    queries.stockInstrumentsGetByAssetIds = args => stockGetInstrumentsByAssetIds(deps.stockReadsRepo, args);
    queries.stockPricesGetLatestByAssetId = args => stockGetPriceLatestByAssetId(deps.stockReadsRepo, args);
    queries.stockPricesGetLatestByAssetIds = args => stockGetPriceLatestByAssetIds(deps.stockReadsRepo, args);
    queries.prestocksGetLatestByMints = args => prestocksGetLatestByMints(deps.prestocksReadsRepo, args);
    queries.stockOhlcvList = args => listStockOhlcv(deps.ohlcvReadsRepo, args);
    queries.ohlcvBounds = args => getOhlcvBounds(deps.ohlcvReadsRepo, args);
    queries.ohlcvList = args => listOhlcv(deps.ohlcvReadsRepo, args);

    const mutations: Record<string, Handler> = Object.create(null);
    mutations.setAssetDescriptionByAssetId = (args, identity) =>
        setAssetDescriptionByAssetId(deps.repo, args, identity);

    // Community token lists. Ownership (owner_project_id) is enforced inside the
    // handlers; the API route passes the caller's projectId from platform auth.
    mutations.tokenListsCreate = args => tokenListsCreateList(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsUpdate = args => tokenListsUpdateList(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsArchive = args => tokenListsArchiveList(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsDelete = args => tokenListsDeleteList(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsUpsertMember = args => tokenListsUpsertMember(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsRemoveMember = args => tokenListsRemoveMember(deps.tokenListsMutationsDeps, args);
    mutations.tokenListsAddMembersBatch = args => tokenListsAddMembersBatch(deps.tokenListsMutationsDeps, args);

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
    // enforces the admin allowlist (TOKENS_ADMIN_CLERK_USER_IDS ∪
    // TOKENS_ADMIN_EMAILS) with 401/403.
    const adminActionsDeps = deps.adminActionsDeps;
    if (adminActionsDeps) {
        mutations.adminCheckVariantMintForCanonical = (args, identity) =>
            adminCheckVariantMintForCanonical(adminActionsDeps, args, identity);
        mutations.adminAddCheckedVariant = (args, identity) => adminAddCheckedVariant(adminActionsDeps, args, identity);
        mutations.adminSeedAsset = (args, identity) => adminSeedAsset(adminActionsDeps, args, identity);
        mutations.adminRefreshChartData = (args, identity) => adminRefreshChartData(adminActionsDeps, args, identity);
    }

    app.get('/health', c => c.json({ ok: true }));
    app.get('/startup', async c => {
        const startedAt = Date.now();
        try {
            await checkStartupDatabase(deps.checkDatabase ?? (async () => {}), deps.startupDatabaseTimeoutMs ?? 2_800);
            return c.json({ ok: true });
        } catch (error) {
            console.error(
                JSON.stringify({
                    ...structuredDatabaseFailure('startup', error, {
                        attempts: 1,
                        elapsedMs: Date.now() - startedAt,
                    }),
                    event: 'cloudrun_assets_startup_database_unavailable',
                }),
            );
            return c.json({ ok: false }, 503);
        }
    });

    const dispatch = (kind: 'query' | 'mutation', table: Record<string, Handler>) => async (c: Context) => {
        if (serviceRole === 'worker') return c.json({ error: 'not_found' }, 404);
        if (!(await isAuthorizedRpcCaller(c.req.header('authorization'), deps))) {
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
        const startedAt = Date.now();
        const retryAtomicRead = kind === 'query' && ATOMIC_RETRY_QUERY_NAMES.has(name);
        let operationAttempts = 1;
        try {
            const invoke = () => handler(args, identityResult);
            const result = retryAtomicRead
                ? await runAtomicReadWithRetry(name, invoke, {
                      onRetry: details => {
                          operationAttempts = 2;
                          console.warn(
                              JSON.stringify({
                                  event: 'cloudrun_assets_db_atomic_read_retry',
                                  revision: process.env.K_REVISION?.trim() || 'local',
                                  instanceId: process.env.HOSTNAME?.trim() || 'local',
                                  ...details,
                              }),
                          );
                      },
                  })
                : await invoke();
            return c.json(result);
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
            console.error(
                JSON.stringify(
                    structuredDatabaseFailure(name, err, {
                        attempts: operationAttempts,
                        elapsedMs: Date.now() - startedAt,
                    }),
                ),
            );
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
    jobs['refresh-curated-ohlcv-15m'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1h'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-4h'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1d'] = refreshCuratedOhlcv;
    jobs['refresh-curated-ohlcv-1w'] = refreshCuratedOhlcv;
    Object.assign(jobs, coingeckoJobs);

    const clickhouseJobsTable: Record<string, ClickhouseJobHandler> = {
        ...clickhouseJobs,
    };

    const miscJobsTable: Record<string, MiscJobHandler> = { ...miscJobs };
    const assetVariantsJobsTable: Record<string, AssetVariantsJobHandler> = {
        ...assetVariantsJobs,
    };
    const seedJobsTable: Record<string, SeedJobHandler> = { ...seedJobs };
    const trendingJobsTable: Record<string, TrendingJobHandler> = {
        ...trendingJobs,
    };
    const clickhouseExtrasJobsTable: Record<string, ClickhouseExtrasJobHandler> = { ...clickhouseExtrasJobs };
    const prestocksJobsTable: Record<string, PrestocksJobHandler> = {
        ...prestocksJobs,
    };

    interface JobGroup {
        has(name: string): boolean;
        /** null = this group's deps are unavailable. */
        run: ((name: string, args: unknown) => Promise<CronResult>) | null;
        disabledError?: string;
    }

    const jobGroups: JobGroup[] = [
        {
            has: name => Object.hasOwn(jobs, name),
            run: deps.cronDeps ? (name, args) => jobs[name]!(deps.cronDeps!, args) : null,
        },
        {
            has: name => Object.hasOwn(clickhouseJobsTable, name),
            run: deps.clickhouseCronDeps
                ? (name, args) => clickhouseJobsTable[name]!(deps.clickhouseCronDeps!, args)
                : null,
            disabledError: 'clickhouse_jobs_disabled',
        },
        {
            has: name => Object.hasOwn(miscJobsTable, name),
            run: deps.miscCronDeps ? (name, args) => miscJobsTable[name]!(deps.miscCronDeps!, args) : null,
        },
        {
            has: name => Object.hasOwn(assetVariantsJobsTable, name),
            run: deps.assetVariantsCronDeps
                ? (name, args) => assetVariantsJobsTable[name]!(deps.assetVariantsCronDeps!, args)
                : null,
        },
        {
            has: name => Object.hasOwn(seedJobsTable, name),
            run: deps.seedCronDeps ? (name, args) => seedJobsTable[name]!(deps.seedCronDeps!, args) : null,
        },
        {
            has: name => Object.hasOwn(trendingJobsTable, name),
            run: deps.trendingCronDeps ? (name, args) => trendingJobsTable[name]!(deps.trendingCronDeps!, args) : null,
        },
        {
            has: name => Object.hasOwn(clickhouseExtrasJobsTable, name),
            run: deps.clickhouseExtrasCronDeps
                ? (name, args) => clickhouseExtrasJobsTable[name]!(deps.clickhouseExtrasCronDeps!, args)
                : null,
        },
        {
            has: name => Object.hasOwn(prestocksJobsTable, name),
            run: deps.prestocksCronDeps
                ? (name, args) => prestocksJobsTable[name]!(deps.prestocksCronDeps!, args)
                : null,
        },
    ];

    app.post('/jobs/:name', async (c: Context) => {
        if (serviceRole === 'api') return c.json({ error: 'not_found' }, 404);
        const verifyOidc = deps.verifyOidc;
        if (!deps.cronDeps || !verifyOidc) {
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
        for (const group of jobGroups) {
            if (!group.has(name)) continue;
            if (!group.run) {
                return c.json({ error: group.disabledError ?? 'jobs_disabled' }, 404);
            }
            try {
                return cronJobResponse(c, await group.run(name, args));
            } catch (err) {
                return jobErrorResponse(c, name, err);
            }
        }
        return c.json({ error: `unknown job: ${name}` }, 404);
    });

    return app;
}
