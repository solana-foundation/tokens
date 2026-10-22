/* eslint-disable no-console */

// Env: TOKENS_API_BASE_URL + TOKENS_API_KEY (API probes), TOKENS_APP_BASE_URL (app probes, optional),
// TOKENS_WEB_BASE_URL (public web-site probes, optional),
// SMOKE_TIMEOUT_MS (per-attempt fetch timeout, default 8000),
// SMOKE_MAX_ATTEMPTS (per-probe retry budget, default 3),
// SMOKE_RETRY_BACKOFF_MS (delay between attempts, default 1000).

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const apiBaseUrl = (process.env.TOKENS_API_BASE_URL ?? '').trim().replace(/\/$/, '');
const appBaseUrl = (process.env.TOKENS_APP_BASE_URL ?? '').trim().replace(/\/$/, '');
const webBaseUrl = (process.env.TOKENS_WEB_BASE_URL ?? '').trim().replace(/\/$/, '');
const apiKey = (process.env.TOKENS_API_KEY ?? '').trim();
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10) || 8000;
const maxAttempts = Math.max(1, Number.parseInt(process.env.SMOKE_MAX_ATTEMPTS ?? '', 10) || 3);
const retryBackoffMs = Math.max(0, Number.parseInt(process.env.SMOKE_RETRY_BACKOFF_MS ?? '', 10) || 1000);
const requireProdClerk = /^(1|true|yes)$/i.test(process.env.SMOKE_REQUIRE_PROD_CLERK ?? '');

if (!apiBaseUrl) {
    console.error('FAILED: TOKENS_API_BASE_URL is required');
    process.exit(1);
}
if (!apiKey) {
    console.error('FAILED: TOKENS_API_KEY is required');
    process.exit(1);
}

type Probe = {
    name: string;
    target: 'api' | 'app' | 'web';
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    auth: boolean;
    expectJson?: boolean;
    budgetMs: number;
    /** Feature the probe needs; see `v2AssetsSkipReason`. */
    requires?: 'v2-assets';
    assert: (ctx: { json: unknown; body: string; status: number; finalUrl: string }) => void;
};

type ProbeResult = {
    name: string;
    target: string;
    method: string;
    path: string;
    status: number | null;
    durationMs: number;
    ok: boolean;
    attempts: number;
    error?: string;
    /** Set when the probe did not run because its feature is not live yet. */
    skipped?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const apiProbes: Probe[] = [
    {
        name: 'health-unauth',
        target: 'api',
        method: 'GET',
        path: '/api/health',
        auth: false,
        budgetMs: 1500,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && json.ok === true, 'expected {"ok": true}');
        },
    },
    {
        name: 'health-v1-unauth',
        target: 'api',
        method: 'GET',
        path: '/api/v1/health',
        auth: false,
        budgetMs: 1500,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && json.ok === true, 'expected {"ok": true}');
        },
    },
    {
        name: 'assets-search',
        target: 'api',
        method: 'GET',
        path: '/api/v1/assets/search?q=sol&limit=5',
        auth: true,
        budgetMs: 3000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.results), 'expected { results: [] }');
            assert((json.results as unknown[]).length > 0, 'search results must be non-empty for q=sol');
        },
    },
    {
        // `/api/v2/search` shipped outside the Clerk middleware allowlist and
        // 401'd every API key in prod; this probe pins v2 reachability.
        name: 'v2-search',
        target: 'api',
        method: 'GET',
        path: '/api/v2/search?q=USDC&limit=5',
        auth: true,
        budgetMs: 5000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.results), 'expected { results: [] }');
            assert((json.results as unknown[]).length > 0, 'v2 search results must be non-empty for q=USDC');
            assert(isObject(json.policy) && json.policy.id === 'default', 'expected policy.id === "default"');
        },
    },
    {
        // Exercises the documented public path (`/v2/...` -> `/api/v2/...`
        // rewrite in next.config.ts); the probe above uses the internal path.
        name: 'v2-resolve-public-path',
        target: 'api',
        method: 'GET',
        path: '/v2/resolve?q=USDC',
        auth: true,
        budgetMs: 5000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200 via the /v2 rewrite, got ${status}`);
            assert(
                isObject(json) && typeof json.status === 'string',
                'expected a resolve envelope with a string status (a 404 here means the /v2 rewrite is missing)',
            );
        },
    },
    {
        name: 'v2-chains',
        target: 'api',
        requires: 'v2-assets',
        method: 'GET',
        path: '/api/v2/chains',
        auth: true,
        budgetMs: 3000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.chains), 'expected { chains: [] }');
            assert((json.chains as unknown[]).length === 6, `expected exactly 6 chains, got ${(json.chains as unknown[]).length}`);
        },
    },
    {
        name: 'v2-assets-majors',
        target: 'api',
        requires: 'v2-assets',
        method: 'GET',
        path: '/api/v2/assets?list=majors&limit=5',
        auth: true,
        budgetMs: 5000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.assets), 'expected { assets: [] }');
            assert((json.assets as unknown[]).length > 0, 'v2 majors must be non-empty');
            assert(
                (json.assets as unknown[]).every(row => isObject(row) && Array.isArray(row.chains)),
                'every v2 asset row must carry a chains[] array',
            );
        },
    },
    {
        // Public path (`/v2/...` rewrite), as v2-resolve-public-path does for search.
        name: 'v2-variant-usdc-public-path',
        target: 'api',
        requires: 'v2-assets',
        method: 'GET',
        path: `/v2/variants/solana/${USDC_MINT}`,
        auth: true,
        budgetMs: 5000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200 via the /v2 rewrite, got ${status}`);
            assert(
                isObject(json) && isObject(json.variant) && json.variant.key === `solana:${USDC_MINT}`,
                'expected variant.key === "solana:<USDC mint>" (a 404 here means the /v2 rewrite is missing)',
            );
        },
    },
    {
        name: 'v2-variants-batch',
        target: 'api',
        requires: 'v2-assets',
        method: 'GET',
        path: `/api/v2/variants?keys=solana:${SOL_MINT}`,
        auth: true,
        budgetMs: 5000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.variants), 'expected { variants: [] }');
            assert((json.variants as unknown[]).length === 1, `expected exactly 1 variant for wrapped SOL, got ${(json.variants as unknown[]).length}`);
        },
    },
    {
        name: 'assets-curated',
        target: 'api',
        method: 'GET',
        path: '/api/v1/assets/curated?list=majors&groupBy=asset',
        auth: true,
        budgetMs: 3000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && Array.isArray(json.assets), 'expected { assets: [] }');
        },
    },
    {
        name: 'assets-variant-markets',
        target: 'api',
        method: 'GET',
        path: '/api/v1/assets/variant-markets',
        auth: true,
        budgetMs: 3000,
        assert: ({ status }) => {
            assert(status === 200, `expected 200, got ${status}`);
        },
    },
    {
        name: 'assets-detail-sol',
        target: 'api',
        method: 'GET',
        path: `/api/v1/assets/${encodeURIComponent(SOL_MINT)}`,
        auth: true,
        budgetMs: 3000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(isObject(json) && isObject(json.asset), 'expected { asset: {...} }');
            assert(
                typeof (json.asset as Record<string, unknown>).assetId === 'string',
                'asset.assetId must be a string',
            );
        },
    },
    {
        name: 'assets-markets-sol',
        target: 'api',
        method: 'GET',
        path: `/api/v1/assets/${encodeURIComponent(SOL_MINT)}/markets`,
        auth: true,
        budgetMs: 3000,
        assert: ({ status }) => {
            assert(status === 200, `expected 200, got ${status}`);
        },
    },
    {
        name: 'assets-profile-sol',
        target: 'api',
        method: 'GET',
        path: `/api/v1/assets/${encodeURIComponent(SOL_MINT)}/profile`,
        auth: true,
        budgetMs: 3000,
        assert: ({ status }) => {
            assert(status === 200, `expected 200, got ${status}`);
        },
    },
    {
        name: 'assets-market-snapshots-post',
        target: 'api',
        method: 'POST',
        path: '/api/v1/assets/market-snapshots',
        body: { mints: [SOL_MINT] },
        auth: true,
        budgetMs: 4000,
        assert: ({ json, status }) => {
            assert(status === 200, `expected 200, got ${status}`);
            assert(Array.isArray(json), 'expected array body');
        },
    },
    {
        name: 'assets-risk-summary-sol',
        target: 'api',
        method: 'GET',
        path: `/api/v1/assets/risk-summary?mint=${encodeURIComponent(SOL_MINT)}`,
        auth: true,
        budgetMs: 3000,
        assert: ({ status }) => {
            assert(status === 200, `expected 200, got ${status}`);
        },
    },
];

const APP_ERROR_MARKERS = [
    "this page couldn't load",
    'this page couldnt load',
    'application error: a client-side exception',
    'internal server error',
    '500 internal server error',
];

const APP_CLERK_DEV_MARKERS = ['pk_test_', '.clerk.accounts.dev', 'dev-browser-missing'];

function assertNoProdClerkDevConfig(body: string): void {
    if (!requireProdClerk) return;
    const lower = body.toLowerCase();
    for (const marker of APP_CLERK_DEV_MARKERS) {
        assert(!lower.includes(marker), `production app response contains Clerk dev marker: "${marker}"`);
    }
}

const appProbes: Probe[] = [
    {
        name: 'app-home',
        target: 'app',
        method: 'GET',
        path: '/',
        auth: false,
        expectJson: false,
        budgetMs: 5000,
        assert: ({ body, status }) => {
            assert(status >= 200 && status < 400, `expected 2xx/3xx, got ${status}`);
            assert(/<html[ >]/i.test(body), 'response missing <html tag');
            const hasNextMarker =
                body.includes('_next') || body.includes('__NEXT_DATA__') || body.includes('next/dist');
            assert(hasNextMarker, 'response missing Next.js SSR markers (_next, __NEXT_DATA__, next/dist)');
            const lower = body.toLowerCase();
            for (const marker of APP_ERROR_MARKERS) {
                assert(!lower.includes(marker), `response contains error marker: "${marker}"`);
            }
            assertNoProdClerkDevConfig(body);
        },
    },
    {
        name: 'app-api-keys-protected',
        target: 'app',
        method: 'GET',
        path: '/api-keys',
        auth: false,
        expectJson: false,
        budgetMs: 5000,
        assert: ({ body, status }) => {
            // /api-keys is Clerk-protected — unauth either redirects to a sign-in page (200 final)
            // or returns a sign-in route directly. Either way we should land somewhere renderable.
            assert(status >= 200 && status < 400, `expected 2xx/3xx, got ${status}`);
            assert(/<html[ >]/i.test(body), 'response missing <html tag');
            const lower = body.toLowerCase();
            for (const marker of APP_ERROR_MARKERS) {
                assert(!lower.includes(marker), `response contains error marker: "${marker}"`);
            }
            assertNoProdClerkDevConfig(body);
        },
    },
];

// Markers that only appear when a Clerk-authenticated app (apps/app or apps/admin)
// is serving the response. apps/web has no Clerk at all, so any of these on the
// public site means the wrong Vercel project has claimed the domain.
const WEB_CLERK_APP_MARKERS = ['pk_live_', 'pk_test_', '__clerk', 'clerk.tokens.xyz'];

const webProbes: Probe[] = [
    {
        name: 'web-home-public',
        target: 'web',
        method: 'GET',
        path: '/',
        auth: false,
        expectJson: false,
        budgetMs: 5000,
        assert: ({ body, status, finalUrl }) => {
            // The public marketing site must be reachable signed-out. If the
            // tokens-app deployment steals the apex domain (e.g. `vercel alias set`
            // with a misconfigured TOKENS_APP_PROD_URL), its Clerk middleware 307s
            // every visitor to /sign-in — that is an outage of the whole web site.
            assert(status === 200, `expected 200, got ${status}`);
            assert(
                !/\/sign-in|\/sign-up/i.test(finalUrl),
                `public web home redirected to an auth page (${finalUrl}) — is the dashboard app serving this domain?`,
            );
            assert(/<html[ >]/i.test(body), 'response missing <html tag');
            const lower = body.toLowerCase();
            for (const marker of APP_ERROR_MARKERS) {
                assert(!lower.includes(marker), `response contains error marker: "${marker}"`);
            }
            for (const marker of WEB_CLERK_APP_MARKERS) {
                assert(
                    !lower.includes(marker),
                    `public web home contains Clerk marker "${marker}" — is the dashboard app serving this domain?`,
                );
            }
        },
    },
];

const probes: Probe[] = [
    ...apiProbes,
    ...(appBaseUrl ? appProbes : []),
    ...(webBaseUrl ? webProbes : []),
];

function probeBaseUrl(probe: Probe): string {
    if (probe.target === 'app') return appBaseUrl;
    if (probe.target === 'web') return webBaseUrl;
    return apiBaseUrl;
}

async function runProbeOnce(probe: Probe): Promise<ProbeResult> {
    const url = `${probeBaseUrl(probe)}${probe.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {};
    if (probe.auth) headers['x-api-key'] = apiKey;
    if (probe.method === 'POST') headers['Content-Type'] = 'application/json';

    const expectJson = probe.expectJson !== false; // default true

    const started = Date.now();
    let status: number | null = null;
    try {
        const res = await fetch(url, {
            method: probe.method,
            headers,
            body: probe.body !== undefined ? JSON.stringify(probe.body) : undefined,
            signal: controller.signal,
            redirect: 'follow',
        });
        status = res.status;
        const text = await res.text();
        const durationMs = Date.now() - started;

        let json: unknown = null;
        if (expectJson && text) {
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`non-JSON response after ${durationMs}ms (${text.slice(0, 200)})`);
            }
        }

        try {
            probe.assert({ json, body: text, status: res.status, finalUrl: res.url });
        } catch (assertErr) {
            const assertMessage = assertErr instanceof Error ? assertErr.message : String(assertErr);
            const slow =
                durationMs > probe.budgetMs
                    ? ` (also breached latency budget: ${durationMs}ms > ${probe.budgetMs}ms)`
                    : '';
            throw new Error(`${assertMessage} [duration=${durationMs}ms]${slow}`);
        }

        if (durationMs > probe.budgetMs) {
            throw new Error(`latency ${durationMs}ms exceeds budget ${probe.budgetMs}ms`);
        }

        return {
            name: probe.name,
            target: probe.target,
            method: probe.method,
            path: probe.path,
            status,
            durationMs,
            ok: true,
            attempts: 1,
        };
    } catch (err) {
        const durationMs = Date.now() - started;
        const message = err instanceof Error ? err.message : String(err);
        return {
            name: probe.name,
            target: probe.target,
            method: probe.method,
            path: probe.path,
            status,
            durationMs,
            ok: false,
            attempts: 1,
            error: message,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function runProbe(probe: Probe): Promise<ProbeResult> {
    let last: ProbeResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await runProbeOnce(probe);
        result.attempts = attempt;
        if (result.ok) return result;
        last = result;
        if (attempt < maxAttempts) {
            await new Promise(r => setTimeout(r, retryBackoffMs));
        }
    }
    return last!;
}

/**
 * The v2 asset routes ship with this script, but the deploy workflow's pre-API
 * prod canary runs against the *previous* API, and the data those probes
 * assert on only exists once sync-v2-solana-variants has run. Until both are
 * true, probes marked `requires: 'v2-assets'` are reported as skipped rather
 * than failed; as soon as the routes answer with data they are enforced like
 * every other probe. Any other state (5xx, network error) is left to the
 * probes themselves so a real outage still fails.
 */
async function v2AssetsSkipReason(): Promise<string | null> {
    const get = async (path: string): Promise<{ status: number; json: unknown }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${apiBaseUrl}${path}`, { headers: { 'x-api-key': apiKey }, signal: controller.signal });
            const text = await res.text();
            let json: unknown = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch {
                json = null;
            }
            return { status: res.status, json };
        } finally {
            clearTimeout(timer);
        }
    };
    try {
        const chains = await get('/api/v2/chains');
        if (chains.status === 404) return 'v2 asset routes not deployed yet (GET /api/v2/chains → 404)';
        if (chains.status !== 200) return null;
        const majors = await get('/api/v2/assets?list=majors&limit=1');
        if (
            majors.status === 200 &&
            isObject(majors.json) &&
            Array.isArray(majors.json.assets) &&
            majors.json.assets.length === 0
        ) {
            return 'v2 asset data not mirrored yet (GET /api/v2/assets?list=majors is empty)';
        }
        return null;
    } catch {
        return null;
    }
}

function skippedResult(probe: Probe, reason: string): ProbeResult {
    return {
        name: probe.name,
        target: probe.target,
        method: probe.method,
        path: probe.path,
        status: null,
        durationMs: 0,
        ok: true,
        attempts: 0,
        skipped: reason,
    };
}

async function main(): Promise<void> {
    const v2Skip = probes.some(p => p.requires === 'v2-assets') ? await v2AssetsSkipReason() : null;
    const settled = await Promise.allSettled(
        probes.map(probe =>
            probe.requires === 'v2-assets' && v2Skip ? Promise.resolve(skippedResult(probe, v2Skip)) : runProbe(probe),
        ),
    );
    const results: ProbeResult[] = settled.map((s, i) => {
        if (s.status === 'fulfilled') return s.value;
        const probe = probes[i]!;
        const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
        return {
            name: probe.name,
            target: probe.target,
            method: probe.method,
            path: probe.path,
            status: null,
            durationMs: 0,
            ok: false,
            attempts: 0,
            error: `unexpected: ${message}`,
        };
    });

    for (const result of results) {
        const tag = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL';
        const statusStr = result.status === null ? '---' : String(result.status);
        const retryNote = result.attempts > 1 ? ` (took ${result.attempts}/${maxAttempts} attempts)` : '';
        console.log(
            `[${tag}] [${result.target}] ${result.name} ${result.method} ${result.path} status=${statusStr} duration=${result.durationMs}ms${retryNote}${
                result.error ? ` error="${result.error}"` : ''
            }${
                result.skipped ? ` skipped="${result.skipped}"` : ''
            }`,
        );
    }

    const failed = results.filter(r => !r.ok);
    const skipped = results.filter(r => r.skipped !== undefined);
    const summary = {
        event: 'smoke_canary_summary',
        api_base_url: apiBaseUrl,
        app_base_url: appBaseUrl || null,
        web_base_url: webBaseUrl || null,
        total: results.length,
        passed: results.length - failed.length - skipped.length,
        failed: failed.length,
        skipped: skipped.length,
        results,
    };
    console.log(JSON.stringify(summary));

    if (failed.length > 0) {
        console.error(`FAILED: ${failed.length}/${results.length} probes failed`);
        process.exit(1);
    }

    console.log(`OK: ${results.length}/${results.length} probes passed`);
}

main().catch(err => {
    console.error('FAILED:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
