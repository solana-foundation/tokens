import { registerGracefulShutdown, wrapFetchWithShutdownGuard } from '@tokens/cloudrun-shutdown';
import { computeMarketScore, type MarketScoreInput } from '@tokens/token-risk-helpers';
import {
    makeBirdeyeClient,
    makeBirdeyeMarketsClient,
    makeBirdeyeOhlcvClient,
    makeClickhouseClient,
    makeCoingeckoClient,
    makeJupiterQuoteClient,
    makeJupiterSwapV2QuoteClient,
    makeJupiterTokenMetadataClient,
    makePreStocksClient,
    makeRwaXyzClient,
    makeSanctumClient,
    makeTitanQuoteClient,
    makeWebacyClient,
} from './clients';
import { makeTitanRestQuoteClient, TITAN_DEMO_BASE_URL } from './titanRestClient';
import { parseAdminClerkUserIds, parseAdminEmails } from './adminAuth';
import {
    getSql,
    makePostgresAdminActionsRepo,
    makePostgresAssetCollectionsReadsRepo,
    makePostgresAssetDeletionTombstonesRepo,
    makePostgresAssetMarketsRepo,
    makePostgresAssetVariantsRepo,
    makePostgresAssetsApiRepo,
    makePostgresAssetsRepo,
    makePostgresCacheWarmAssetsRepo,
    makePostgresClickhouseRepo,
    makePostgresCoingeckoCuratedSource,
    makePostgresCoingeckoReadsRepo,
    makePostgresCoingeckoRepo,
    makePostgresCuratedMintsSource,
    makePostgresFillQualityReadsRepo,
    makePostgresJobsRepo,
    makePostgresMiscJobsRepo,
    makePostgresOhlcvReadsRepo,
    makePostgresSanctumLstsRepo,
    makePostgresSeedRepo,
    makePostgresTokenListsMutationsRepo,
    makePostgresTokenListsReadsRepo,
    makePostgresTokensReadsRepo,
    makePostgresTrendingReadsRepo,
    makePostgresTrendingRepo,
    makePostgresClickhouseExtrasRepo,
    makePostgresDepthCurveReadsRepo,
    makePostgresDepthCurvesRepo,
    makePostgresPrestocksReadsRepo,
    makePostgresPrestocksRepo,
    makePostgresStockReadsRepo,
    makePostgresVariantMarketsRepo,
} from './db';
import type { AdminActionsDeps } from './handlers/adminActions';
import type { CacheWarmDeps } from './handlers/cacheWarm';
import type { CronDeps } from './handlers/crons';
import type { ClickhouseCronDeps } from './handlers/crons.clickhouse';
import type { MiscCronDeps } from './handlers/crons.misc';
import type { AssetVariantsCronDeps } from './handlers/crons.assetVariants';
import type { SeedCronDeps } from './handlers/crons.seed';
import type { TrendingCronDeps } from './handlers/crons.trending';
import type { ClickhouseExtrasCronDeps } from './handlers/crons.clickhouse.extras';
import type { PrestocksCronDeps } from './handlers/crons.prestocks';
import type { DepthCronDeps } from './handlers/crons.depth';
import { limitQuoteConcurrency, paceQuoteStarts, type DepthSampleDeps, type LiveQuoteDeps } from './handlers/liveQuotes';
import { createConcurrencyLimiter } from './concurrencyLimiter';
import { makeGoogleOidcVerifier } from './oidc';
import { createApp, type ServiceRole } from './server';

const authToken = process.env.TOKENS_CLOUDRUN_AUTH_TOKEN?.trim();
if (!authToken) {
    console.error('TOKENS_CLOUDRUN_AUTH_TOKEN must be set');
    process.exit(1);
}

const port = Number(process.env.PORT) || 8080;
const serviceRoleRaw = process.env.SERVICE_ROLE?.trim() || 'api';
if (serviceRoleRaw !== 'api' && serviceRoleRaw !== 'worker') {
    console.error('SERVICE_ROLE must be api or worker');
    process.exit(1);
}
const serviceRole: ServiceRole = serviceRoleRaw;
const sql = getSql();

const birdeyeApiKey = process.env.BIRDEYE_API_KEY?.trim();
const sanctumApiKey = process.env.SANCTUM_API_KEY?.trim();
const webacyApiKey = process.env.WEBACY_API_KEY?.trim();
const rwaApiKey = process.env.RWA_API_KEY?.trim();

const cronInvokerSa = process.env.TOKENS_CRON_INVOKER_SA?.trim() || undefined;
const cronAudience = process.env.SCHEDULER_OIDC_AUDIENCE?.trim() || undefined;

const clickhouseUrl = process.env.CLICKHOUSE_URL?.trim();
const clickhouseUser = process.env.CLICKHOUSE_USER?.trim();
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD?.trim();
const clickhouseDatabase = process.env.CLICKHOUSE_DATABASE?.trim();

let cronDeps: CronDeps | undefined;
let clickhouseCronDeps: (CronDeps & ClickhouseCronDeps) | undefined;
let miscCronDeps: MiscCronDeps | undefined;
let assetVariantsCronDeps: AssetVariantsCronDeps | undefined;
let seedCronDeps: SeedCronDeps | undefined;
let trendingCronDeps: TrendingCronDeps | undefined;
let clickhouseExtrasCronDeps: ClickhouseExtrasCronDeps | undefined;
let prestocksCronDeps: PrestocksCronDeps | undefined;
let depthCronDeps: DepthCronDeps | undefined;
let verifyOidc: ReturnType<typeof makeGoogleOidcVerifier> | undefined;
if (birdeyeApiKey) {
    if (!cronAudience && !cronInvokerSa) {
        console.error(
            'SCHEDULER_OIDC_AUDIENCE or TOKENS_CRON_INVOKER_SA must be set when /jobs/* is enabled (BIRDEYE_API_KEY is present); refusing to start with no audience/invoker pin.',
        );
        process.exit(1);
    }
    const curated = makePostgresCuratedMintsSource(sql);
    const coingeckoCurated = makePostgresCoingeckoCuratedSource(sql);
    const baseDeps: CronDeps = {
        repo: makePostgresJobsRepo(sql),
        curated,
        birdeye: makeBirdeyeClient({
            apiKey: birdeyeApiKey,
            ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
        }),
        birdeyeOhlcv: makeBirdeyeOhlcvClient({
            apiKey: birdeyeApiKey,
            ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
        }),
        sanctum: makeSanctumClient({ apiKey: sanctumApiKey }),
        webacy: makeWebacyClient({ apiKey: webacyApiKey }),
        ...(rwaApiKey ? { rwaXyz: makeRwaXyzClient({ apiKey: rwaApiKey }) } : {}),
        coingeckoRepo: makePostgresCoingeckoRepo(sql),
        coingeckoCurated,
        coingecko: makeCoingeckoClient({ apiKey: process.env.COINGECKO_API_KEY?.trim() }),
        now: () => Date.now(),
        computeMarketScore: (input: MarketScoreInput) => computeMarketScore(input),
    };
    coingeckoCurated.warmup().catch(err => {
        console.error('[cloudrun-assets] coingecko curated warmup failed', err);
    });
    cronDeps = baseDeps;
    if (clickhouseUrl && clickhouseUser && clickhousePassword && clickhouseDatabase) {
        clickhouseCronDeps = {
            ...baseDeps,
            clickhouseRepo: makePostgresClickhouseRepo(sql),
            clickhouse: makeClickhouseClient({
                url: clickhouseUrl,
                username: clickhouseUser,
                password: clickhousePassword,
                database: clickhouseDatabase,
                ...(process.env.CLICKHOUSE_STOCK_TRADES_TABLE
                    ? { stockTradesTable: process.env.CLICKHOUSE_STOCK_TRADES_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_STOCK_INSTRUMENTS_TABLE
                    ? { stockInstrumentsTable: process.env.CLICKHOUSE_STOCK_INSTRUMENTS_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_SOLANA_TRADES_TABLE
                    ? { solanaTradesTable: process.env.CLICKHOUSE_SOLANA_TRADES_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_STOCK_PRICE_SCALE
                    ? { priceScale: Number(process.env.CLICKHOUSE_STOCK_PRICE_SCALE) }
                    : {}),
            }),
            env: () => process.env,
        };
    } else {
        console.warn('[cloudrun-assets] CLICKHOUSE_* not fully set — clickhouse /jobs/* disabled');
    }
    miscCronDeps = {
        base: cronDeps,
        repo: makePostgresMiscJobsRepo(sql),
        birdeyeMarkets: makeBirdeyeMarketsClient({
            apiKey: birdeyeApiKey,
            ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
        }),
    };
    assetVariantsCronDeps = {
        assetVariantsRepo: makePostgresAssetVariantsRepo(sql),
        now: () => Date.now(),
    };
    const birdeyeClientForIdentity = makeBirdeyeClient({
        apiKey: birdeyeApiKey,
        ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
    });
    trendingCronDeps = {
        repo: makePostgresTrendingRepo(sql),
        now: () => Date.now(),
    };
    // PreStocks needs no API key — the reference endpoint is unauthenticated.
    prestocksCronDeps = {
        prestocks: makePreStocksClient(),
        repo: makePostgresPrestocksRepo(sql),
        now: () => Date.now(),
    };
    if (clickhouseUrl && clickhouseUser && clickhousePassword && clickhouseDatabase) {
        clickhouseExtrasCronDeps = {
            clickhouse: makeClickhouseClient({
                url: clickhouseUrl,
                username: clickhouseUser,
                password: clickhousePassword,
                database: clickhouseDatabase,
                ...(process.env.CLICKHOUSE_STOCK_TRADES_TABLE
                    ? { stockTradesTable: process.env.CLICKHOUSE_STOCK_TRADES_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_STOCK_INSTRUMENTS_TABLE
                    ? { stockInstrumentsTable: process.env.CLICKHOUSE_STOCK_INSTRUMENTS_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_SOLANA_TRADES_TABLE
                    ? { solanaTradesTable: process.env.CLICKHOUSE_SOLANA_TRADES_TABLE.trim() }
                    : {}),
                ...(process.env.CLICKHOUSE_STOCK_PRICE_SCALE
                    ? { priceScale: Number(process.env.CLICKHOUSE_STOCK_PRICE_SCALE) }
                    : {}),
            }),
            repo: makePostgresClickhouseExtrasRepo(sql),
            curated,
            now: () => Date.now(),
            env: () => process.env,
        };
    }
    seedCronDeps = {
        repo: makePostgresSeedRepo(sql),
        now: () => Date.now(),
        birdeyeIdentity: {
            async fetchIdentityByMint(mint: string) {
                const overview = await birdeyeClientForIdentity.fetchTokenOverview(mint);
                if (!overview) return { symbol: null, name: null };
                const sym =
                    typeof overview.symbol === 'string' && overview.symbol.trim() ? overview.symbol.trim() : null;
                const nameRaw = typeof overview.name === 'string' && overview.name.trim() ? overview.name.trim() : null;
                const name = nameRaw && nameRaw.toLowerCase() !== 'unknown' ? nameRaw : null;
                return { symbol: sym, name };
            },
        },
    };
    verifyOidc = makeGoogleOidcVerifier({
        ...(cronAudience ? { audience: cronAudience } : {}),
        ...(cronInvokerSa ? { invokerEmail: cronInvokerSa } : {}),
    });
    curated.warmup().catch(err => {
        console.error('[cloudrun-assets] curated mints warmup failed', err);
    });
} else {
    console.warn('[cloudrun-assets] BIRDEYE_API_KEY not set — /jobs/* endpoints disabled');
}

// Depth sampling has its own credentials (not coupled to BIRDEYE_API_KEY);
// the job additionally no-ops unless DEPTH_REFRESH_ENABLED=true is set.
const titanWsUrl = process.env.TITAN_WS_URL?.trim();
const titanApiKey = process.env.TITAN_API_KEY?.trim();
if (titanWsUrl && titanApiKey) {
    depthCronDeps = {
        quoteSource: makeTitanQuoteClient({ wsUrl: titanWsUrl, authToken: titanApiKey }),
        repo: makePostgresDepthCurvesRepo(sql),
        now: () => Date.now(),
        env: () => process.env,
    };
} else {
    console.warn('[cloudrun-assets] TITAN_WS_URL/TITAN_API_KEY not set — depth /jobs/* disabled');
}

const jupiterApiKey = process.env.JUPITER_API_KEY?.trim();
if (!jupiterApiKey) {
    console.warn(
        '[cloudrun-assets] JUPITER_API_KEY not set — Jupiter Swap V2 comparison disabled; Lite token metadata remains available',
    );
}

// Titan REST (live quote comparison) is configured independently of the
// WebSocket depth client: different transport, different auth mechanism.
// TITAN_REST_API_KEY falls back to TITAN_API_KEY so a single credential still
// works, but the base URL must be explicit — TITAN_DEMO_BASE_URL is Titan's
// demo cluster, and defaulting to it would quote demo liquidity in production.
const titanRestApiKey = process.env.TITAN_REST_API_KEY?.trim() || titanApiKey;
const titanRestBaseUrl = process.env.TITAN_REST_BASE_URL?.trim();
const titanRestAllowDemo = process.env.TITAN_REST_ALLOW_DEMO?.trim().toLowerCase() === 'true';

let titanRestQuoteSource: ReturnType<typeof makeTitanRestQuoteClient> | undefined;
if (!titanRestApiKey) {
    console.warn('[cloudrun-assets] TITAN_REST_API_KEY/TITAN_API_KEY not set — Titan quote comparison disabled');
} else if (!titanRestBaseUrl && !titanRestAllowDemo) {
    console.warn(
        '[cloudrun-assets] TITAN_REST_BASE_URL not set — Titan quote comparison disabled ' +
            '(set TITAN_REST_ALLOW_DEMO=true to quote Titan’s demo cluster in local dev)',
    );
} else {
    const baseUrl = titanRestBaseUrl ?? TITAN_DEMO_BASE_URL;
    if (!titanRestBaseUrl) {
        console.warn(`[cloudrun-assets] Titan quote comparison using the DEMO cluster (${baseUrl})`);
    }
    try {
        titanRestQuoteSource = makeTitanRestQuoteClient({
            authToken: titanRestApiKey,
            baseUrl,
            ...(process.env.TITAN_QUOTE_USER_PUBLIC_KEY?.trim()
                ? { userPublicKey: process.env.TITAN_QUOTE_USER_PUBLIC_KEY.trim() }
                : {}),
        });
    } catch (error) {
        console.warn('[cloudrun-assets] Titan REST comparison disabled:', error);
    }
}

// Live comparison is separate from the sampled depth source and its WebSocket.
// Per-provider in-flight caps sized for the cross-variant fanout (up to
// 6 variants x 2 concurrent amounts): enough parallelism to fill a wide
// request, low enough that one request cannot 429-storm a provider.
const jupiterQuoteLimiter = createConcurrencyLimiter(6);
const titanQuoteLimiter = createConcurrencyLimiter(8);
const liveQuoteDeps: LiveQuoteDeps = {
    jupiterTokenMetadataSource: makeJupiterTokenMetadataClient(jupiterApiKey ? { apiKey: jupiterApiKey } : {}),
    ...(jupiterApiKey
        ? {
              // Paced to Jupiter's ~10 req/s paid-tier budget (observed via
              // x-ratelimit headers), then capped in-flight.
              jupiterQuoteSource: limitQuoteConcurrency(
                  paceQuoteStarts(makeJupiterSwapV2QuoteClient({ apiKey: jupiterApiKey }), 120),
                  jupiterQuoteLimiter,
              ),
          }
        : {}),
    ...(titanRestQuoteSource ? { titanQuoteSource: limitQuoteConcurrency(titanRestQuoteSource, titanQuoteLimiter) } : {}),
    now: () => Date.now(),
};
const depthSampleDeps: DepthSampleDeps = {
    quoteSource: depthCronDeps?.quoteSource ?? makeJupiterQuoteClient(jupiterApiKey ? { apiKey: jupiterApiKey } : {}),
    curvesRepo: makePostgresDepthCurvesRepo(sql),
    readsRepo: makePostgresDepthCurveReadsRepo(sql),
    now: () => Date.now(),
};

let cacheWarmDeps: CacheWarmDeps | undefined;
if (cronDeps && miscCronDeps && seedCronDeps) {
    cacheWarmDeps = {
        cron: cronDeps,
        misc: miscCronDeps,
        ...(clickhouseCronDeps ? { clickhouse: clickhouseCronDeps } : {}),
        ...(clickhouseExtrasCronDeps ? { clickhouseExtras: clickhouseExtrasCronDeps } : {}),
        seed: seedCronDeps,
        stockReadsRepo: makePostgresStockReadsRepo(sql),
        assetsRepo: makePostgresCacheWarmAssetsRepo(sql),
        env: () => process.env,
        now: () => Date.now(),
    };
} else {
    console.warn('[cloudrun-assets] cron deps not fully set — /mutation/cacheWarm* endpoints disabled');
}

// Accept WIF-minted Google ID tokens from the Vercel admin app on RPC routes
// (pinned to the invoker SA, and to this service's URL when provided).
const rpcInvokerSa = process.env.TOKENS_RPC_INVOKER_SA?.trim();
const rpcOidcAudience = process.env.TOKENS_RPC_OIDC_AUDIENCE?.trim();
const rpcVerifyOidc = rpcInvokerSa
    ? makeGoogleOidcVerifier({ invokerEmail: rpcInvokerSa, ...(rpcOidcAudience ? { audience: rpcOidcAudience } : {}) })
    : undefined;

const adminAllowlist = {
    clerkUserIds: parseAdminClerkUserIds(process.env.TOKENS_ADMIN_CLERK_USER_IDS),
    emails: parseAdminEmails(process.env.TOKENS_ADMIN_EMAILS),
};
if (adminAllowlist.clerkUserIds.size === 0 && adminAllowlist.emails.size === 0) {
    console.warn(
        '[cloudrun-assets] TOKENS_ADMIN_CLERK_USER_IDS and TOKENS_ADMIN_EMAILS are both empty — /mutation/admin* endpoints will reject all callers',
    );
}

let adminActionsDeps: AdminActionsDeps | undefined;
if (cronDeps && miscCronDeps && seedCronDeps) {
    adminActionsDeps = {
        adminAllowlist,
        repo: makePostgresAdminActionsRepo(sql),
        seedRepo: seedCronDeps.repo,
        cron: cronDeps,
        misc: miscCronDeps,
        now: () => Date.now(),
    };
} else {
    console.warn('[cloudrun-assets] cron deps not fully set — /mutation/admin* endpoints disabled');
}

const app = createApp({
    repo: makePostgresAssetsRepo(sql),
    assetsApiRepo: makePostgresAssetsApiRepo(sql),
    deletionTombstonesRepo: makePostgresAssetDeletionTombstonesRepo(sql),
    sanctumLstsRepo: makePostgresSanctumLstsRepo(sql),
    assetMarketsRepo: makePostgresAssetMarketsRepo(sql),
    variantMarketsRepo: makePostgresVariantMarketsRepo(sql),
    assetVariantsRepo: makePostgresAssetVariantsRepo(sql),
    tokensReadsRepo: makePostgresTokensReadsRepo(sql),
    trendingReadsRepo: makePostgresTrendingReadsRepo(sql),
    fillQualityReadsRepo: makePostgresFillQualityReadsRepo(sql),
    depthCurveReadsRepo: makePostgresDepthCurveReadsRepo(sql),
    assetCollectionsReadsRepo: makePostgresAssetCollectionsReadsRepo(sql),
    tokenListsReadsRepo: makePostgresTokenListsReadsRepo(sql),
    tokenListsMutationsDeps: {
        repo: makePostgresTokenListsMutationsRepo(sql),
        // Without a Birdeye key, mints unknown to the registry/tokens table
        // simply resolve as unknown_mint instead of snapshotting metadata.
        fetchTokenOverview: async mint => (cronDeps ? cronDeps.birdeye.fetchTokenOverview(mint) : null),
        now: () => Date.now(),
    },
    coingeckoReadsRepo: makePostgresCoingeckoReadsRepo(sql),
    stockReadsRepo: makePostgresStockReadsRepo(sql),
    ohlcvReadsRepo: makePostgresOhlcvReadsRepo(sql),
    prestocksReadsRepo: makePostgresPrestocksReadsRepo(sql),
    authToken,
    serviceRole,
    checkDatabase: async () => {
        await sql`SELECT 1`;
    },
    ...(cronDeps && verifyOidc ? { cronDeps, verifyOidc } : {}),
    ...(rpcVerifyOidc ? { rpcVerifyOidc } : {}),
    ...(clickhouseCronDeps ? { clickhouseCronDeps } : {}),
    ...(miscCronDeps ? { miscCronDeps } : {}),
    ...(assetVariantsCronDeps ? { assetVariantsCronDeps } : {}),
    ...(seedCronDeps ? { seedCronDeps } : {}),
    ...(trendingCronDeps ? { trendingCronDeps } : {}),
    ...(clickhouseExtrasCronDeps ? { clickhouseExtrasCronDeps } : {}),
    ...(prestocksCronDeps ? { prestocksCronDeps } : {}),
    ...(depthCronDeps ? { depthCronDeps } : {}),
    liveQuoteDeps,
    depthSampleDeps,
    ...(cacheWarmDeps ? { cacheWarmDeps } : {}),
    ...(adminActionsDeps ? { adminActionsDeps } : {}),
});

registerGracefulShutdown({ sql, serviceName: 'cloudrun-assets' });

export default { port, fetch: wrapFetchWithShutdownGuard(app.fetch) };
