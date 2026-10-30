import { bearerTokenCandidates, registerGracefulShutdown, wrapFetchWithShutdownGuard } from '@tokens/cloudrun-shutdown';
import { computeMarketScore, type MarketScoreInput } from '@tokens/token-risk-helpers';
import {
    makeBirdeyeClient,
    makeBirdeyeMarketsClient,
    makeBirdeyeOhlcvClient,
    makeClickhouseClient,
    makeCoingeckoClient,
    makeCoingeckoFiatRatesClient,
    makeJupiterQuoteClient,
    makeJupiterSwapV2QuoteClient,
    makeJupiterTokenMetadataClient,
    makePreStocksClient,
    makeRwaXyzClient,
    makeSanctumClient,
    makeStonkfunClient,
    makeSolanaDataClient,
    makeTitanQuoteClient,
    makeWebacyClient,
    makeWebacyDepegClient,
} from './clients';
import { makeTitanRestQuoteClient, TITAN_DEMO_BASE_URL } from './titanRestClient';
import { makePostgresDepegRepo } from './db/depeg';
import { makePostgresV2AssetsJobsRepo, makePostgresV2AssetsReadsRepo } from './db/v2Assets';
import { birdeyeChains, type ChainKind } from '@tokens/asset-registry/chains';
import type { BirdeyeClient } from './handlers/crons';
import type { V2AssetsCronDeps } from './handlers/crons.v2Assets';
import { makePostgresPegGuardRepo } from './db/pegGuard';
import { parseAdminClerkUserIds, parseAdminEmails } from './adminAuth';
import {
    getSql,
    makePostgresAdminActionsRepo,
    makePostgresAssetAdvisoriesRepo,
    makePostgresStablecoinHealthReadsRepo,
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
    makePostgresCuratedMembershipSource,
    makePostgresFillQualityReadsRepo,
    makePostgresAssetRiskReadsRepo,
    makePostgresJobsRepo,
    makePostgresLaunchpadJobsRepo,
    makePostgresLaunchpadReadsRepo,
    makePostgresLogoSyncRepo,
    makePostgresMiscJobsRepo,
    makePostgresOhlcvReadsRepo,
    makePostgresSanctumLstsRepo,
    makePostgresSeedRepo,
    makePostgresSolanaDataJobsRepo,
    makePostgresSolanaDataReadsRepo,
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
import {
    DEFAULT_TOKEN_LIST_CAPS,
    withOverviewMissCache,
    type TokenListsMutationsDeps,
} from './handlers/tokenListsMutations';
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
import type { LaunchpadCronDeps } from './handlers/crons.launchpad';
import type { LogoSyncCronDeps } from './handlers/crons.logoSync';
import type { SolanaDataCronDeps } from './handlers/crons.solanaData';
import { makeSharpLogoNormalizer } from './handlers/logoImage';
import { makeGcsLogoStore } from './logoStore';
import type { LaunchpadAdminDeps } from './handlers/launchpadAdminActions';
import type { DepegCronDeps } from './handlers/crons.depeg';
import { makeGoogleOidcVerifier } from './oidc';
import { createApp, type ServiceRole } from './server';

/** Positive-integer env override with a default. */
function envInt(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
const solanaDataApiKey = process.env.SOLANA_DATA_API_KEY?.trim();
const solanaDataApiUrl = process.env.SOLANA_DATA_API_URL?.trim();

const cronInvokerSa = process.env.TOKENS_CRON_INVOKER_SA?.trim() || undefined;
const cronAudience = process.env.SCHEDULER_OIDC_AUDIENCE?.trim() || undefined;

let cronDeps: CronDeps | undefined;
let clickhouseCronDeps: (CronDeps & ClickhouseCronDeps) | undefined;
let miscCronDeps: MiscCronDeps | undefined;
let assetVariantsCronDeps: AssetVariantsCronDeps | undefined;
let seedCronDeps: SeedCronDeps | undefined;
let trendingCronDeps: TrendingCronDeps | undefined;
let clickhouseExtrasCronDeps: ClickhouseExtrasCronDeps | undefined;
let prestocksCronDeps: PrestocksCronDeps | undefined;
let depthCronDeps: DepthCronDeps | undefined;
let launchpadCronDeps: LaunchpadCronDeps | undefined;
let logoSyncCronDeps: LogoSyncCronDeps | undefined;
let solanaDataCronDeps: SolanaDataCronDeps | undefined;
let depegCronDeps: DepegCronDeps | undefined;
let v2AssetsCronDeps: V2AssetsCronDeps | undefined;
let verifyOidc: ReturnType<typeof makeGoogleOidcVerifier> | undefined;

// Effective curated membership is served on the read path too (the
// curatedMembershipGetSnapshot RPC), so the source exists regardless of
// whether /jobs/* is enabled.
const curated = makePostgresCuratedMembershipSource(sql);
curated.warmup().catch(err => {
    console.error('[cloudrun-assets] curated membership warmup failed', err);
});

if (birdeyeApiKey) {
    if (!cronAudience && !cronInvokerSa) {
        console.error(
            'SCHEDULER_OIDC_AUDIENCE or TOKENS_CRON_INVOKER_SA must be set when /jobs/* is enabled (BIRDEYE_API_KEY is present); refusing to start with no audience/invoker pin.',
        );
        process.exit(1);
    }
    const coingeckoCurated = makePostgresCoingeckoCuratedSource(sql);
    // Held separately because CronDeps.birdeye is typed as the narrower
    // BirdeyeClient; the peg guard needs the multi-price half of this instance.
    const birdeye = makeBirdeyeClient({
        apiKey: birdeyeApiKey,
        ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
    });
    const baseDeps: CronDeps = {
        repo: makePostgresJobsRepo(sql),
        curated,
        birdeye,
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
    clickhouseCronDeps = {
        ...baseDeps,
        clickhouseRepo: makePostgresClickhouseRepo(sql),
        clickhouse: makeClickhouseClient({}),
        env: () => process.env,
    };
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
        listCanonicalCuratedMints: () => curated.getAllCuratedMintsInOrder(),
    };
    // PreStocks needs no API key — the reference endpoint is unauthenticated.
    prestocksCronDeps = {
        prestocks: makePreStocksClient(),
        repo: makePostgresPrestocksRepo(sql),
        now: () => Date.now(),
    };
    // stonk.fun needs no API key; the sync only runs where Birdeye is available
    // because new coins get their identity (decimals/logo) from Birdeye.
    launchpadCronDeps = {
        base: baseDeps,
        repo: makePostgresLaunchpadJobsRepo(sql),
        stonkfun: makeStonkfunClient(),
    };
    // Project Canon asset registry (data.solana.com). Lives in this block because
    // the provider phase fills missing logos from Birdeye; the sync itself only
    // needs the data team's key.
    if (solanaDataApiKey) {
        solanaDataCronDeps = {
            repo: makePostgresSolanaDataJobsRepo(sql),
            solanaData: makeSolanaDataClient({
                apiKey: solanaDataApiKey,
                ...(solanaDataApiUrl ? { baseUrl: solanaDataApiUrl } : {}),
            }),
            birdeye,
            now: () => Date.now(),
        };
    } else {
        console.warn('[cloudrun-assets] SOLANA_DATA_API_KEY not set — /jobs/sync-solana-data-assets disabled');
    }
    // First-party logo copies land in the public asset-logo bucket (same one
    // cloudrun-admin signs uploads for) via the runtime SA's default
    // credentials, so the only optional inputs are the Pinata gateway.
    const gcsLogoBucket = process.env.GCS_LOGO_BUCKET?.trim();
    if (gcsLogoBucket) {
        const pinataGatewayHost = process.env.PINATA_GATEWAY_HOST?.trim();
        const pinataGatewayToken = process.env.PINATA_GATEWAY_TOKEN?.trim();
        const jupiterTokenApiUrl = process.env.JUPITER_TOKEN_API_URL?.trim();
        logoSyncCronDeps = {
            base: baseDeps,
            repo: makePostgresLogoSyncRepo(sql),
            store: makeGcsLogoStore(gcsLogoBucket, process.env.GCS_LOGO_PUBLIC_BASE_URL?.trim()),
            normalizer: makeSharpLogoNormalizer(),
            ...(pinataGatewayHost ? { pinataGatewayHost } : {}),
            ...(pinataGatewayToken ? { pinataGatewayToken } : {}),
            ...(jupiterTokenApiUrl ? { jupiterTokenApiUrl } : {}),
        };
        if (!pinataGatewayHost) {
            console.warn('[cloudrun-assets] PINATA_GATEWAY_HOST not set — logo-sync skips the Pinata source for IPFS logos');
        }
    } else {
        console.warn('[cloudrun-assets] GCS_LOGO_BUCKET not set — /jobs/logo-sync disabled');
    }
    // The depeg job group only needs Birdeye (the peg guard prices from it);
    // the Webacy jobs share the token-risk key and return webacy_not_configured
    // via the client's isConfigured() when it is missing.
    // v2 multichain: one Birdeye client per covered chain (the `x-chain` header
    // is per instance), sharing the key with the Solana crons.
    const birdeyeByChain: Partial<Record<ChainKind, BirdeyeClient>> = Object.fromEntries(
        birdeyeChains().map(chain => [
            chain,
            makeBirdeyeClient({
                apiKey: birdeyeApiKey,
                chain,
                ...(process.env.BIRDEYE_ORIGIN ? { origin: process.env.BIRDEYE_ORIGIN } : {}),
            }),
        ]),
    );
    v2AssetsCronDeps = {
        repo: makePostgresV2AssetsJobsRepo(sql),
        birdeyeByChain,
        now: () => Date.now(),
    };
    depegCronDeps = {
        webacyDepeg: makeWebacyDepegClient({ apiKey: webacyApiKey ?? '' }),
        repo: makePostgresDepegRepo(sql),
        curated,
        now: () => Date.now(),
        pegGuard: {
            birdeye,
            repo: makePostgresPegGuardRepo(sql),
            // Fiat pegs (EURC, tGBP, ...) are judged against a CoinGecko-implied
            // rate; the key is the same one the markets refresh uses.
            fiatRates: makeCoingeckoFiatRatesClient({ apiKey: process.env.COINGECKO_API_KEY?.trim() }),
        },
    };
    if (!webacyApiKey) {
        console.warn('[cloudrun-assets] WEBACY_API_KEY not set: Webacy depeg jobs disabled (peg guard still runs)');
    }
    clickhouseExtrasCronDeps = {
        clickhouse: makeClickhouseClient({}),
        repo: makePostgresClickhouseExtrasRepo(sql),
        curated,
        now: () => Date.now(),
        env: () => process.env,
    };
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
              // Paced to Jupiter's ~10 req/s paid-tier budget, capped in-flight.
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
// stonk.fun lookups for the admin Launches page; needs only the allowlist,
// the provider client, and the DB (no Birdeye), so it is always available.
const launchpadAdminDeps: LaunchpadAdminDeps = {
    adminAllowlist,
    stonkfun: makeStonkfunClient(),
    repo: makePostgresLaunchpadJobsRepo(sql),
    curated,
    // "Sync now" can fetch identity for a brand-new coin only when Birdeye is configured.
    ...(cronDeps ? { identity: { birdeye: cronDeps.birdeye, baseRepo: cronDeps.repo } } : {}),
    now: () => Date.now(),
};
const v2AssetsReadsRepo = makePostgresV2AssetsReadsRepo(sql);
// v2AssetsCronDeps is built in the same Birdeye block as cronDeps, so the
// admin actions (which mirror into / write the v2 tables) share its gate.
if (cronDeps && miscCronDeps && seedCronDeps && v2AssetsCronDeps) {
    adminActionsDeps = {
        adminAllowlist,
        repo: makePostgresAdminActionsRepo(sql),
        seedRepo: seedCronDeps.repo,
        cron: cronDeps,
        misc: miscCronDeps,
        v2: v2AssetsCronDeps,
        v2Reads: v2AssetsReadsRepo,
        now: () => Date.now(),
    };
} else {
    console.warn('[cloudrun-assets] cron deps not fully set — /mutation/admin* endpoints disabled');
}

const tokenListsMutationsDeps: TokenListsMutationsDeps = {
    repo: makePostgresTokenListsMutationsRepo(sql),
    // Without a Birdeye key, mints unknown to the registry/tokens table
    // simply resolve as unknown_mint instead of snapshotting metadata.
    // Miss-cached: unknown mints stop replaying against the provider.
    fetchTokenOverview: withOverviewMissCache(async mint =>
        cronDeps ? cronDeps.birdeye.fetchTokenOverview(mint) : null,
    ),
    now: () => Date.now(),
    caps: {
        batch: envInt('TOKEN_LIST_BATCH_CAP', DEFAULT_TOKEN_LIST_CAPS.batch),
        membersPerList: envInt('TOKEN_LIST_MEMBERS_PER_LIST_CAP', DEFAULT_TOKEN_LIST_CAPS.membersPerList),
        providerLookups: envInt('TOKEN_LIST_PROVIDER_LOOKUP_BUDGET', DEFAULT_TOKEN_LIST_CAPS.providerLookups),
        listsPerProject: envInt('TOKEN_LIST_LISTS_PER_PROJECT_CAP', DEFAULT_TOKEN_LIST_CAPS.listsPerProject),
    },
    // Freed slugs are reclaimable only by their previous owner for this window.
    slugHoldMs: (Number(process.env.TOKEN_LIST_SLUG_HOLD_DAYS) || 30) * 24 * 60 * 60 * 1000,
};

const app = createApp({
    repo: makePostgresAssetsRepo(sql),
    assetsApiRepo: makePostgresAssetsApiRepo(sql),
    deletionTombstonesRepo: makePostgresAssetDeletionTombstonesRepo(sql),
    assetAdvisoriesRepo: makePostgresAssetAdvisoriesRepo(sql),
    stablecoinHealthReadsRepo: makePostgresStablecoinHealthReadsRepo(sql),
    sanctumLstsRepo: makePostgresSanctumLstsRepo(sql),
    assetMarketsRepo: makePostgresAssetMarketsRepo(sql),
    variantMarketsRepo: makePostgresVariantMarketsRepo(sql),
    assetVariantsRepo: makePostgresAssetVariantsRepo(sql),
    tokensReadsRepo: makePostgresTokensReadsRepo(sql),
    trendingReadsRepo: makePostgresTrendingReadsRepo(sql),
    fillQualityReadsRepo: makePostgresFillQualityReadsRepo(sql),
    depthCurveReadsRepo: makePostgresDepthCurveReadsRepo(sql),
    assetRiskReadsRepo: makePostgresAssetRiskReadsRepo(sql),
    assetCollectionsReadsRepo: makePostgresAssetCollectionsReadsRepo(sql),
    curatedMembershipSource: curated,
    tokenListsReadsRepo: makePostgresTokenListsReadsRepo(sql),
    tokenListsMutationsDeps,
    coingeckoReadsRepo: makePostgresCoingeckoReadsRepo(sql),
    stockReadsRepo: makePostgresStockReadsRepo(sql),
    ohlcvReadsRepo: makePostgresOhlcvReadsRepo(sql),
    prestocksReadsRepo: makePostgresPrestocksReadsRepo(sql),
    launchpadReadsRepo: makePostgresLaunchpadReadsRepo(sql),
    v2AssetsReadsRepo,
    solanaDataReadsRepo: makePostgresSolanaDataReadsRepo(sql),
    authToken: bearerTokenCandidates(authToken, process.env.TOKENS_CLOUDRUN_AUTH_TOKEN_PREVIOUS),
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
    ...(launchpadCronDeps ? { launchpadCronDeps } : {}),
    ...(logoSyncCronDeps ? { logoSyncCronDeps } : {}),
    ...(solanaDataCronDeps ? { solanaDataCronDeps } : {}),
    launchpadAdminDeps,
    ...(depegCronDeps ? { depegCronDeps } : {}),
    ...(v2AssetsCronDeps ? { v2AssetsCronDeps } : {}),
    ...(cacheWarmDeps ? { cacheWarmDeps } : {}),
    ...(adminActionsDeps ? { adminActionsDeps } : {}),
    tokenListsAdminDeps: { adminAllowlist, lists: tokenListsMutationsDeps },
});

registerGracefulShutdown({ sql, serviceName: 'cloudrun-assets' });

export default { port, fetch: wrapFetchWithShutdownGuard(app.fetch) };
