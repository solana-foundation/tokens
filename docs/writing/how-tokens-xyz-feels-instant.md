# How tokens.xyz feels instant on top of a rate-limited API

tokens.xyz is rendered from the same public API that anyone can call with a key. There is no private backdoor for the website. Every token page you see is assembled from `api.tokens.xyz`, with one shared platform key that has the same burst limit, sustained limit, and provider budgets as any customer key.

That constraint shaped everything. A customer key gets 400 requests per 10 seconds, 1,000 per minute, and a search provider budget of 120 uncached lookups per 10 minutes. The website's key goes through the same limiter and the same provider budgets. So a wasted request from the browser is not just a slow render for one person. It spends a budget that every visitor shares.

I read the performance.dev breakdown of why Linear is so fast and recognised the shape of the problem, but not the solution. Linear is write-heavy, so it moved the database into the browser and built a sync engine. tokens.xyz is read-heavy. Prices move every second, but almost nobody writes. A sync engine would be the wrong tool. What we built instead is a stack of caches, each with a lifetime that has a reason, and a rule at every layer: before you fetch, ask who already has this.

This post walks through that stack from the first paint down to the database. The code is open at [solana-foundation/tokens](https://github.com/solana-foundation/tokens), and every excerpt below has its file path, so you can read the surrounding context.

What I'll cover:

1. Ship the shell before you ask the API anything
2. Cache the shape you serve, not the bytes you fetch
3. The proxy is the CDN
4. One client cache, many readers
5. Fetch at the moment it matters
6. Make URLs the CDN can share
7. Realtime without polling
8. Render less, later, off the main path
9. Images are API calls too
10. What the API does so the browser doesn't have to
11. What I haven't done yet
12. The checklist

## 1. Ship the shell before you ask the API anything

The site runs on Next.js 16 with cache components and partial prefetching turned on. Every route has a static shell that can be prerendered and served from the edge without touching the API.

```ts
const nextConfig: NextConfig = {
    // Instant Navigations (Next 16.3): explicit caching via 'use cache' and
    // per-route static shells that prefetch/render instantly on client navs.
    cacheComponents: true,
    partialPrefetching: true,
```

`apps/web/next.config.ts`

The asset page is the one that matters most, because that is where people land from search. Its top-level component does no work before returning JSX. The shell streams first, and everything that depends on `/api/v1/assets/:id` streams in behind a Suspense boundary.

```tsx
export function AssetPage(props: AssetPageProps) {
    // No awaits before JSX: flush the page shell (breadcrumb, header identity,
    // section chrome) immediately and stream the `/api/v1/assets/:id`-dependent
    // content in via Suspense. `page.tsx` has already validated the asset
    // (registry or resolve API) and owns notFound(); `AssetPageContent` degrades
    // gracefully to registry data when the fetch returns null, so no
    // notFound/error semantics cross the Suspense boundary.
    return (
        <Suspense fallback={<AssetPageShellFallback {...props} />}>
            <AssetPageContent {...props} />
        </Suspense>
    );
}
```

`apps/web/src/app/[name]/asset-page.tsx`

The fallback is not a spinner. It is the real page with the numbers missing: breadcrumb, name, symbol, logo, section headings. That is possible because the asset registry is a package bundled into the app, with `Map` indexes by id, alias, CoinGecko id and mint. Resolving `/bitcoin` or `/jupiter` never leaves the process. The route only calls the API's resolve endpoint when the registry misses.

```tsx
const assetFromName = getAssetByCoingeckoId(name) ?? resolveAlias(name) ?? getAsset(name);
const assetFromRequestedMint =
    requestedMint && requestedMint.trim().length > 0
        ? (getVariantByMint(requestedMint)?.asset ?? resolveAlias(requestedMint) ?? getAsset(requestedMint))
        : null;
const asset = assetFromName ?? assetFromRequestedMint;
if (asset) {
    ...
    return <AssetPage asset={asset} requestedName={name} requestedMint={requestedMint} />;
}

const resolvedAsset = await resolveCanonicalAsset(name, requestedMint);
```

`apps/web/src/app/[name]/page.tsx`

The home page follows the same split. The hero and search box prerender. The token table streams in behind a fallback that reproduces the real layout, including 64 pixel rows, so the swap to live data does not shift anything.

On pages whose data comes from a secret-protected upstream, like the registry, there is one more trick. Calling `connection()` inside the Suspense boundary keeps the fetch out of the build-time prerender. The `'use cache'` inside the fetch still shares the result across requests at runtime.

```tsx
/**
 * `connection()` keeps the registry fetch out of the build-time prerender so
 * the static shell never depends on SOLANA_DATA_API_KEY or the upstream
 * being reachable; the hourly `use cache` inside fetchRegistry still applies
 * across requests.
 */
async function RegistryLoader() {
    await connection();
```

`apps/web/src/app/registry/page.tsx`

The lesson: the fallback should be the page minus the numbers, and route resolution should not need the network. If you can name the thing before you can price it, name it first.

## 2. Cache the shape you serve, not the bytes you fetch

The heat map is built from the union of every curated list with every variant's full market snapshot. That raw response is about 1.5 MB. The tree the page actually renders is a fifth of that. So the cache holds the tree.

```ts
/**
 * Caches the slimmed tree, not the upstream responses: the raw union is
 * ~1.5 MB (every variant's full market snapshot), the tree a fifth of that.
 * Throws on any failure so the error is never cached: the page falls back to
 * an "unavailable" panel and the next request retries the API.
 */
export async function fetchHeatmapData(): Promise<HeatmapData> {
    'use cache';
    cacheLife('minutes');

    const [response, membership] = await Promise.all([
        fetchJson<RawCuratedResponse>(CURATED_ALL_PATH),
        fetchSectorMembership(),
    ]);

    const data = buildHeatmapData(response, membership, Date.now());
    if (data.assetCount === 0) throw new Error('Curated assets response contained no assets');
    return data;
}
```

`apps/web/src/app/heatmap/lib/fetch-heatmap.ts`

Two details in that function carry most of the weight. First, it throws on any failure, including an empty success. A cached error would be served to everyone for the whole window, so errors must never enter the cache. Second, the lifetime is a profile, not a number, and each function picks its own. The trending sector in the same file uses `cacheLife({ stale: 30, revalidate: 30, expire: 300 })` because trending moves fast. The registry uses `cacheLife('hours')` because it changes a few times a day.

The registry fetch also shows how to shape requests. It needs market data for every mint in the registry. Instead of one call per mint, it posts batches of 250 to the market-snapshots endpoint with four workers in flight, and only asks Birdeye for metadata on mints that still have no logo after that.

```ts
const byMint = new Map<string, MarketSnapshotEntry>();
let cursor = 0;
const worker = async () => {
    while (cursor < batches.length) {
        const batch = batches[cursor++]!;
        const entries = await fetchApiAppJsonOrNull<MarketSnapshotEntry[]>('/api/v1/assets/market-snapshots', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mints: batch }),
        });
        for (const entry of entries ?? []) {
            if (entry?.address) byMint.set(entry.address, entry);
        }
    }
};
await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, batches.length) }, worker));
```

`apps/web/src/app/registry/lib/fetch-registry.ts`

Within a single request, `React.cache` handles the other kind of duplication. On the asset page the header, the sidebar and the stats section all need the global profile. They each call `loadGlobalStats`, and the fetch runs once.

```ts
const loadGlobalStats = cache(
    async (
        assetId: string,
        coingeckoId: string | null,
        enableCoinGeckoFallback: boolean,
    ): Promise<GlobalTokenStats | null> => {
        // Profile is optional (requires extra scopes). Load separately so `assets:read` can still render the page.
        const apiProfile = await fetchApiAppJsonOrNull<AssetsV1AssetResponse>(
            `/api/v1/assets/${encodeURIComponent(assetId)}?${new URLSearchParams({ include: 'profile' }).toString()}`,
            { next: { revalidate: 300 } },
        );
```

`apps/web/src/app/[name]/asset-page.tsx`

Every server-side fetch carries a revalidate window chosen by how fast that data changes:

| Data               | Revalidate |
| ------------------ | ---------- |
| Trending list      | 15 s       |
| Curated list       | 30 s       |
| Asset detail       | 60 s       |
| Curated lists meta | 60 s       |
| Profile and risk   | 300 s      |

The lesson: cache after transformation so the cache is small and the hot path does no work, pick the lifetime from the data's real rate of change, and never let a failure in.

## 3. The proxy is the CDN

The browser never talks to `api.tokens.xyz` directly. It calls `/api/v1/...` on tokens.xyz, and a route handler forwards the request with the platform key attached. That proxy exists for the key, but it does a second job that matters more for speed.

The API marks its responses `private`. The reason is in the API's cache policy builder:

```ts
/**
 * IMPORTANT: every v1 route is authenticated via `x-api-key`, and shared
 * caches do not vary on that header by default — so policies default to
 * `private` (browser-only caching). Do not use `public`/`s-maxage` until the
 * CDN is configured to key its cache on the API key.
 */
```

`apps/api/src/effect/cache-control.ts`

A CDN cannot share a response that was produced for one key, because the next caller might have a different key with different scopes. But once the website's proxy has added its own key, every response it produces is for the same key. So the proxy rewrites the header on successful GETs to something the CDN can share.

```ts
function applyProxyCacheControl(
    headers: Headers,
    method: string,
    status: number,
    cacheSeconds: ProxyCacheSeconds | undefined,
): void {
    if (method !== 'GET' || cacheSeconds === undefined) return;
    if (status >= 200 && status < 300 && typeof cacheSeconds === 'number') {
        headers.set('cache-control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`);
    } else {
        headers.set('cache-control', 'no-store');
    }
}
```

`apps/web/src/app/api/_platform-proxy.ts`

The window depends on the path. Trending and anything that includes live markets are `no-store`, because those numbers are the product and a stale one is worse than a slow one. Search gets 30 seconds, since query strings are personal but still shared by enough people to be worth caching briefly. Everything else gets 60 seconds with a four-minute stale-while-revalidate tail, so a burst of visitors after a tweet is served from the edge while one request refreshes the entry.

```ts
export function proxyPlatformGet(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === '/api/v1/assets/trending') {
        return proxyPlatformRequest(request, { cache: 'no-store' });
    }
    ...
    if (pathname === '/api/v1/assets/search') {
        // Query strings are user-specific but still shareable; keep the CDN window short.
        return proxyPlatformRequest(request, { next: { revalidate: 60 } }, 30);
    }

    return proxyPlatformRequest(request, { next: { revalidate: 60 } });
}
```

`apps/web/src/app/api/_platform-proxy.ts`

Three smaller decisions in the same file each closed a real incident. The proxy strips the browser's `accept-encoding` header because Vercel will happily answer with zstd and Node's fetch will not decode it, which once meant proxying compressed bytes as JSON. It merges the incoming request's abort signal into the upstream fetch, so when a visitor closes the tab the API call is cancelled instead of running to completion for nobody. And it retries exactly once, only on network failure, only for GET. HTTP error statuses pass through untouched and mutations are never replayed.

The lesson: put the credential and the cache policy in the same place. The CDN can only share what you tell it is shareable, and the only layer that knows that is the one holding the key.

## 4. One client cache, many readers

On the client the data store is TanStack Query. There is no second store for API data. The defaults are deliberate:

```ts
new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
        },
    },
}),
```

`apps/web/src/providers/query-provider.tsx`

Refetch on window focus is off because switching tabs is not a data event. With prices arriving over a stream anyway, a focus refetch would be a wasted call against the shared budget every time someone came back from Slack.

The first problem with a client cache on a server-rendered page is the double fetch: the server fetched the list, then the client mounts and fetches it again. The fix is to seed the cache with the server snapshot and tell it when that snapshot was taken, so the normal stale time still drives the next refresh.

```tsx
// When `initialTokens` were (approximately) fetched, so staleTime applies accurately.
// Captured on first client render: the server can't stamp Date.now() because that
// would block the prerendered shell under cacheComponents.
const [initialFetchedAt] = useState(() => Date.now());
...
// Seed react-query with the SSR snapshot for the initial category only. `initialData`
// is only consumed when the cache entry is empty, and `initialDataUpdatedAt` lets the
// hooks' normal staleTime drive revalidation instead of pinning the snapshot forever.
const seedCurated = !isTrending && activeCategoryId === initialCategoryId;
```

`apps/web/src/components/home/home-tokens-provider.tsx`

The timestamp detail is a gotcha worth knowing. Under cache components, calling `Date.now()` on the server would make the whole shell dynamic. So the client stamps the time on first render. It is off by the hydration delay, which is fine for a one-minute stale window.

The second problem is features that overlap. The search palette wants the curated lists to rank results. The home page already loaded them. Because both use the same query key, the palette reads what the home page fetched and issues nothing new.

```ts
const curatedCategoryQueries = useQueries({
    queries: TOKEN_SEARCH_LIST_ORDER.map(listId => ({
        queryKey: ['tokens', 'curated', listId],
        queryFn: ({ signal }: { signal?: AbortSignal }) => fetchCuratedTokens(listId, signal),
        staleTime: 60 * 1000,
        enabled: open && hasQuery,
    })),
});
```

`apps/web/src/components/token-search-dialog.tsx`

My favourite example takes this one step further. The home table draws a sparkline per row, and the price column next to it wants the latest close. The naive version fetches OHLCV twice. Instead, the price column subscribes to the query cache itself and reads whatever the sparkline already loaded, walking the same fallback chain the chart uses. It never fetches.

```ts
const subscribe = useCallback(
    (onStoreChange: () => void) => {
        const cache = queryClient.getQueryCache();
        return cache.subscribe(event => {
            const queryKey = event?.query?.queryKey;
            if (!queryKey) return;
            if (keyIdSet.has(getQueryKeyId(queryKey))) onStoreChange();
        });
    },
    [queryClient, keyIdSet],
);

return useSyncExternalStore(
    subscribe,
    () => {
        // Match `InlinePriceChart`: primary → fallback → extended.
        const primary = queryClient.getQueryData<OHLCVData[]>(queryKeys[0]);
        if ((primary?.length ?? 0) > 0) return pickLatestClose(primary);
```

`apps/web/src/hooks/queries/use-inline-latest-close.ts`

The last piece is what happens when a request fails. The shared retry predicate refuses to retry any 4xx, including 429.

```ts
/**
 * Shared TanStack Query retry predicate for queries backed by `apiJson`.
 * 4xx statuses are not transient for the client — retrying just increases
 * load and makes rate limits worse.
 */
export function shouldRetryApiQuery(failureCount: number, error: unknown, maxRetries = 2): boolean {
    if (error instanceof ApiResponseError) {
        if ([400, 401, 403, 404, 429].includes(error.status)) return false;
    }

    return failureCount < maxRetries;
}
```

`apps/web/src/effect/query-retry.ts`

Retrying a rate limit is how a small spike becomes an outage. On a shared key it would be self-inflicted.

The lesson: treat the query cache as the store. A second component that needs the same data should read it, not fetch it, and the way to make that possible is to agree on keys.

## 5. Fetch at the moment it matters

A table of 100 tokens with a sparkline each is 100 chart requests. Most of them are below the fold. So each sparkline watches an `IntersectionObserver` with a 200 pixel margin and only enables its query once it has been near the viewport.

```ts
const observer = new IntersectionObserver(
    ([entry]) => {
        const nextInView = Boolean(entry?.isIntersecting);
        setIsInView(nextInView);
        if (nextInView) setHasEnteredView(true);
    },
    {
        threshold: 0,
        rootMargin: '200px 0px',
    },
);
```

`apps/web/src/components/inline-price-chart.tsx`

Charts have fallbacks too: a different interval, then a longer range, for assets that trade thinly. Those are gated on the primary query having returned fewer than two points, so a healthy asset never pays for its fallbacks.

```ts
const shouldEnableCanonicalFallback =
    hasEnteredView && shouldUseCanonical && !canonicalQuery.isLoading && (canonicalQuery.data?.length ?? 0) < 2;
```

`apps/web/src/components/inline-price-chart.tsx`

Going the other way, some fetches should start before the user asks. Hovering a table row for 75 milliseconds prefetches that asset page's server payload, once per route per mount, so the click lands on a warm cache.

```ts
// Hover-intent prefetch: warm the RSC payload for a row's target route shortly
// before the user clicks. Each href is prefetched at most once per mount.
function prefetchRow(token: Token) {
    const href = getRowHref(token);
    if (prefetchedHrefs.current.has(href)) return;
    prefetchedHrefs.current.add(href);
    router.prefetch(href);
}

function handleRowPointerEnter(token: Token) {
    if (prefetchTimerRef.current !== null) clearTimeout(prefetchTimerRef.current);
    prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null;
        prefetchRow(token);
    }, ROW_PREFETCH_HOVER_DELAY_MS);
}
```

`apps/web/src/components/home/token-table.tsx`

Code gets the same treatment. The search palette is a separate chunk, and hovering or focusing the search button starts loading it. By the time someone types, the dialog is already in memory.

```tsx
const preloadDialog = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    void import('./token-search-dialog');
}, []);
...
<button
    type="button"
    onClick={() => handleOpenSearch('click')}
    onMouseEnter={preloadDialog}
    onFocus={preloadDialog}
```

`apps/web/src/components/token-search.tsx`

The heat map pushes intent furthest. Hovering a sector header computes that sector's layout and caches it, then starts loading its logos through the exact URLs the tiles will request, capped at 48 per view. The click only has to mount what hover already prepared.

```ts
/**
 * Warm the browser cache with the logos `layout` will draw, using the same optimizer URLs the
 * tiles request, so a view opens with its logos in place. Browser only.
 */
export function preloadTileLogos(layout: HeatmapLayout): void {
    ...
            const { props } = getImageProps({ src, alt: '', width: LOGO_SOURCE_SIZE, height: LOGO_SOURCE_SIZE });
            const image = new window.Image();
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            if (props.srcSet) image.srcset = props.srcSet;
            image.src = props.src;
            if (++started >= MAX_PRELOADS_PER_LAYOUT) return;
```

`apps/web/src/app/heatmap/lib/preload-logos.ts`

Intent cuts both ways. Next.js prefetches every `<Link>` that enters the viewport by default. On a grid of 400 heat map tiles or a registry table, that is hundreds of prefetches nobody asked for. Those links set `prefetch={false}` and leave warming to hover.

The lesson: hover, focus and approaching the viewport are free signals. Use them to fetch just before the user needs something, and turn automatic prefetch off wherever it fans out.

## 6. Make URLs the CDN can share

Every cache in the previous sections keys on the URL. A URL with `Date.now()` in it is a new key every millisecond, and every layer misses. So chart requests align their time range to the minute.

```ts
queryFn: async ({ signal }) => {
    // Align timestamps so caching works across users (avoid a unique URL per second).
    const now = alignEpochSeconds(Math.floor(Date.now() / 1000), 60);
    const from = alignEpochSeconds(now - days * 24 * 60 * 60, 60);

    const params = new URLSearchParams({
        include: 'ohlcv',
        ohlcvInterval: interval,
        ohlcvFrom: String(from),
        ohlcvTo: String(now),
    });
```

`apps/web/src/hooks/queries/use-asset-ohlcv.ts`

Two visitors loading the same chart in the same minute now share one entry in the browser cache, the CDN, and Next's fetch cache.

The same thinking applies to what a URL asks for. The asset endpoint takes `include=profile`, `include=markets` or `include=ohlcv`, and each section of the page asks for only its slice. A page that asked for everything would produce one huge response with the shortest lifetime of any part. Separate URLs let the profile cache for five minutes while markets stay live.

Versioning is the other half. The dominant-colour endpoint, which picks a background tint from a logo, carries an algorithm version in its URL. The cache busts when the algorithm changes and never otherwise.

```ts
// Include an algorithm version to bust browser/CDN caches when the heuristic changes.
url: `/api/dominant-color?url=${encodeURIComponent(url)}&v=${DOMINANT_COLOR_ALGO_VERSION}`,
```

`apps/web/src/hooks/queries/use-dominant-color.ts`

The lesson: every per-user or per-moment bit in a URL is a cache miss for everyone. Round timestamps, ask for slices, and version what you want to invalidate.

## 7. Realtime without polling

Prices on an asset page update every second. The obvious implementation is `refetchInterval`. There is not a single `refetchInterval` in the codebase. Live prices come from a Pyth Hermes server-sent events stream, which is one open connection instead of a request per second per visitor.

The stream can tick faster than React should render. The hook throttles UI updates to once per second, and keeps the last tick in a ref so nothing is lost.

```ts
onTick: tick => {
    latestTickRef.current = tick;
    lastRealtimeTickAtRef.current = Date.now();

    const now = Date.now();
    if (now - lastUiUpdateAtRef.current < UI_THROTTLE_MS) return;
    lastUiUpdateAtRef.current = now;

    const updatedAtMs = tick.publishTimeMs ?? now;
    setLiveSpotPrice(args.quoteKey, { priceUsd: tick.priceUsd, updatedAtMs, source: 'pyth' });
```

`apps/web/src/hooks/use-realtime-quote.ts`

Two more details keep it honest. The server-rendered price seeds the live store before the stream connects, so there is a number on screen from the first frame. And if no tick arrives for 7.5 seconds, the status degrades to a fallback state and the UI shows the last server price instead of pretending the stale stream value is live.

The lesson: one stream beats N polls, and a throttle between the stream and React keeps rendering off the hot path.

## 8. Render less, later, off the main path

Not every millisecond is spent waiting on the network. The home table lists every asset in a category, which can run to hundreds of rows, each with a logo, a sparkline and an animated price. It uses a window virtualizer with fixed-height rows and renders about a screen and a half.

```ts
const rowVirtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => TOKEN_TABLE_ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
    useFlushSync: false,
});
```

`apps/web/src/components/home/token-table.tsx`

The heat map is the harder case, because a treemap has no rows to virtualize. Opening the stocks sector means mounting about 400 tiles while a zoom animation is running. It mounts the 48 largest tiles in the click's frame and the rest in interruptible batches inside `startTransition`.

```ts
// A big view (all ~400 stocks) mounts its largest tiles in the click's frame and the rest in
// interruptible batches while the camera is still moving, instead of one long blocking task.
const ranking = useMemo(() => tilesBySize(layout), [layout]);
const [mounted, setMounted] = useState(() => Math.min(ranking.length, FIRST_BATCH));
const total = ranking.length;
useEffect(() => {
    if (mounted >= total) return;
    startTransition(() => setMounted(count => Math.min(total, count + NEXT_BATCH)));
}, [mounted, total]);
```

`apps/web/src/app/heatmap/components/heatmap-layer.tsx`

Switching the period from 24 hours to 7 days recolours every tile. The toggle itself must respond on the frame it was clicked, so the tiles read a deferred copy of the period and are allowed to trail by one frame.

```ts
// Recolouring every tile can trail the toggle by a frame; the toggle itself must not.
const tilePeriod = useDeferredValue(period);
```

`apps/web/src/app/heatmap/components/heatmap.tsx`

Layouts are memoised per view and stage size, so returning to a sector is a cache hit, and a single delegated tooltip at the stage level replaces a handler per tile.

Finally, what is not on the critical path should not be in the first bundle. The charts, the search palette, and the floating market feed with its motion and icon libraries all load through `dynamic()` with `ssr: false`.

```ts
const InlinePriceChart = dynamic(() => import('@/components/inline-price-chart').then(m => m.InlinePriceChart), {
    ssr: false,
    loading: () => <div className="w-full h-8 rounded-sm bg-gray-50" />,
});
```

`apps/web/src/components/home/token-table.tsx`

The lesson: virtualize what has rows, batch what does not, and reach for `startTransition` and `useDeferredValue` before reaching for a worker. They are the cheap way to keep input responsive.

## 9. Images are API calls too

A token logo is a request to a third party you do not control, usually an IPFS gateway or an Arweave node. Public IPFS gateways rate-limit and block aggressively, and when they do, half the site shows broken images.

The site routes every logo through its own image proxy. The proxy has a host allowlist, sniffs the content type from magic bytes, caps images at 2 MB, and rewrites any `ipfs://` reference or public gateway URL to a private Pinata gateway, with the gateway token kept server-side.

```ts
function resolveIpfsTarget(src: string): { url: URL; headers: Record<string, string> } | null {
    const ref = extractIpfsRef(src);
    const host = process.env.PINATA_GATEWAY_HOST?.trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
    if (!ref || !host) return null;
    const token = process.env.PINATA_GATEWAY_TOKEN?.trim();
    return {
        url: new URL(`https://${host}/ipfs/${ref.cid}${ref.path}`),
        headers: token ? { 'x-pinata-gateway-token': token } : {},
    };
}
```

`apps/web/src/app/api/image-proxy/route.ts`

The response gets a day of shared cache and a week of stale-while-revalidate, because logos almost never change and a stale logo is harmless.

```ts
'Cache-Control': fresh
    ? 'no-store, no-cache, must-revalidate'
    : 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
```

`apps/web/src/app/api/image-proxy/route.ts`

Once a logo is cached at the proxy, sending it through the Next image optimizer is a second hop for no gain. The registry table skips it.

```ts
// Logos already served by our image proxy are CDN-cached there; skip the optimizer's extra hop.
function isProxiedLogo(src: string): boolean {
    return src.startsWith('/api/image-proxy?');
}
```

`apps/web/src/app/registry/registry-table.tsx`

Table logos are `loading="lazy"` with `decoding="async"`. Only the asset page header logo gets `priority`. When an image fails anyway, the component falls back to an initials circle rather than a broken icon.

The lesson: a logo is a request with a cache policy. Decide who serves it, how long it lives, and what the user sees when it fails, the same way you would for JSON.

## 10. What the API does so the browser doesn't have to

Everything above is the web app. It only works because the API behind it does not compute on request.

Scheduled jobs on Cloud Run refresh market data, risk scores, prices and peg health into `*_latest` tables in Postgres every minute to every few hours, depending on the source. Routes read rows. When a route needs a provider, that is the exception, and a per-key provider budget caps how often it can happen.

For the heaviest endpoints, the API wraps the handler in a last-good cache. A healthy payload is written to Redis, a failure is answered with the last healthy payload for the same key, and an empty success is never allowed to become the last-good copy.

```ts
/**
 * Last-good response cache: serve slightly stale data instead of a 500 or a
 * degraded (near-empty) 200.
 *
 * `withStaleFallback` wraps a route handler effect so that
 * - every healthy successful payload is written to Redis (best-effort,
 *   throttled),
 * - a 5xx-class failure is answered with the last healthy payload for the
 *   same cache key (marked `stale: true`) when one exists, and
 * - an *unhealthy* success (per `isHealthy` — e.g. a payload assembled while
 *   every downstream call defaulted to empty) is replaced by the last healthy
 *   payload when one exists, and is never written to the cache.
 *
 * 4xx-class failures (bad request, auth, rate limit) are never masked — they
 * propagate unchanged.
```

`apps/api/src/effect/stale-response-cache.ts`

The most useful thing I learned from the API side this month is that a cache can be slower than the thing it fronts. Our Redis primary sits in us-west-1 and the API runs in iad1. A cache hit on the auth lookup cost about 62 ms. The uncached call to the usage service it was protecting cost 12 to 16 ms. We deleted the cache and the API got faster.

The same geography showed up again on the curated endpoint, where a fresh hit from Redis cost about 80 ms. The fix was a tiny per-process tier of 8 entries in front of Redis, and moving the last-good write to after the response is sent. On search, the fix was finding a serial loop: Solana alone has about 1,500 liquid-staking variants, and a gap-fill step was fetching their markets 250 at a time in sequence, adding about 380 ms. Running those chunks concurrently removed it.

The lesson: a cache in the wrong region is slower than no cache. Measure the hit, not just the miss, and measure it from where the code runs.

## 11. What I haven't done yet

The Linear article ends by saying the hard part is sustained craft, not any one trick. I agree, and the honest version of that is a list of what is still rough.

- The command palette has no debounce. Every keystroke past two characters is a new search query. The 30 second CDN window on search absorbs most of it, but it should be debounced.
- Sparklines are one request per visible row. A batched endpoint for the visible set would cut that to one.
- Cache invalidation is purely time-based. There are no cache tags, so an admin edit takes up to a cache window to show.
- The registry table is paginated at 50 rows, not virtualized.
- Price-chart and news requests go through an uncached catch-all route, so they get browser caching only.
- There is no Lighthouse CI or bundle budget. Measurement is PostHog web vitals in production and React Doctor in CI.

Each of those is a known cost that has not yet been worth paying. Some will be.

## 12. The checklist

If you build a front end on top of a rate-limited API, this is the list I would hand you.

1. Ship a shell that needs no network. The fallback is the page minus the numbers.
2. Cache after transformation, not before. Store the shape you render.
3. Never cache a failure. Throw so the error cannot enter the cache.
4. Make responses `public` at the one layer that holds the credential, with an explicit `s-maxage` per path.
5. Use one client store and agree on query keys, so the second reader reads instead of fetching.
6. Seed the client store from the server render, with the timestamp, so you do not double fetch.
7. Fetch on intent. Hover, focus and nearing the viewport are free signals. Turn automatic prefetch off where it fans out.
8. Round timestamps and ask for slices, so URLs are shareable across users.
9. Stream, do not poll, and throttle between the stream and React.
10. Virtualize rows, batch what has no rows, and defer the recolour, not the click.
11. Treat images as requests with a cache policy and a failure state.
12. Measure cache hits from where the code runs. A cache in the wrong region is slower than no cache.

There is no single trick in here. There is the same question asked at every layer, from the edge to the database: who already has this? When the answer is someone, read it from them. When the answer is nobody, fetch it once, shape it, and give it a lifetime with a reason.

The code is at [github.com/solana-foundation/tokens](https://github.com/solana-foundation/tokens). The API's own cache and rate-limit behaviour is documented at [docs.tokens.xyz](https://docs.tokens.xyz). If you spot something I got wrong or something you would do differently, I would like to hear it.
