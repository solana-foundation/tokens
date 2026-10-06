'use client';

import * as React from 'react';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Effect } from 'effect';
import { apiJson } from '@/effect/api-client';
import { shouldRetryApiQuery } from '@/effect/query-retry';
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion } from 'motion/react';
import { ArrowUpRight, ChevronDown, ChevronUp, Info, Settings2, X } from 'lucide-react';

import { cn } from '@tokens/ui/cn';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { Skeleton } from '@tokens/ui/skeleton';
import { Switch } from '@tokens/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tokens/ui/tooltip';
import type { CoinGeckoNewsArticle } from '@/lib/coingecko';
import { trackEvent } from '@/lib/posthog-client';
import {
    DEFAULT_FLOATING_MARKET_FEED_SETTINGS,
    FLOATING_MARKET_FEED_SIZE_OPTIONS,
    getFloatingMarketFeedEmptyNoun,
    getFloatingMarketFeedSource,
    getFloatingMarketFeedTitle,
    getNextFloatingMarketFeedSize,
    getNextHeatmapSector,
    resolveNextFloatingMarketFeedSettings,
    sanitizeFloatingMarketFeedSettings,
    type FloatingMarketFeedSettings,
} from './floating-market-feed-utils';
import { HeatmapMini } from '@/app/heatmap/components/heatmap-mini';
import type { HeatmapMiniResponse } from '@/app/heatmap/lib/preview';
import { useFloatingMarketFeedContext } from './floating-market-feed-context';

const EMPTY_ARTICLES: CoinGeckoNewsArticle[] = [];
const EMPTY_TERMS: string[] = [];
const SPACEX_MARKET_BANNER_ACTIVE = false;
const MARKET_BANNER_DISMISSED_AT_KEY = 'tokens:market-banner-dismissed-at';
const FLOATING_MARKET_FEED_SETTINGS_KEY = 'tokens:floating-market-feed-settings:v2';
const MARKET_BANNER_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isMarketBannerDismissed(): boolean {
    try {
        const raw = window.localStorage.getItem(MARKET_BANNER_DISMISSED_AT_KEY);
        if (!raw) return false;

        const dismissedAt = Number(raw);
        if (!Number.isFinite(dismissedAt)) return false;

        return Date.now() - dismissedAt < MARKET_BANNER_DISMISS_TTL_MS;
    } catch {
        return false;
    }
}

function persistMarketBannerDismissal() {
    try {
        window.localStorage.setItem(MARKET_BANNER_DISMISSED_AT_KEY, String(Date.now()));
    } catch {
        // Ignore storage failures (private mode, quota, etc.) — dismissal still applies for this session.
    }
}

// Tracks dismissals that couldn't be persisted (private mode, quota, etc.) so the
// banner still hides for the current session, plus listeners for same-tab updates.
let marketBannerDismissedThisSession = false;
const marketBannerDismissalListeners = new Set<() => void>();

function subscribeToMarketBannerDismissal(listener: () => void): () => void {
    marketBannerDismissalListeners.add(listener);
    // Keep other tabs in sync when the dismissal timestamp changes.
    window.addEventListener('storage', listener);
    return () => {
        marketBannerDismissalListeners.delete(listener);
        window.removeEventListener('storage', listener);
    };
}

function getMarketBannerVisibleSnapshot(): boolean {
    return !marketBannerDismissedThisSession && !isMarketBannerDismissed();
}

// Render hidden on the server (and during hydration) so server and client markup
// match; the client snapshot reveals the banner before paint once we've confirmed
// it wasn't recently dismissed (persisted in localStorage).
function getMarketBannerVisibleServerSnapshot(): boolean {
    return false;
}

function useMarketBannerDismissal() {
    const visible = React.useSyncExternalStore(
        subscribeToMarketBannerDismissal,
        getMarketBannerVisibleSnapshot,
        getMarketBannerVisibleServerSnapshot,
    );

    const dismiss = React.useCallback(() => {
        marketBannerDismissedThisSession = true;
        persistMarketBannerDismissal();
        for (const listener of marketBannerDismissalListeners) listener();
    }, []);

    return { visible, dismiss };
}

function shouldHideFloatingMarketFeed(pathname: string | null): boolean {
    return (
        pathname === '/assets-api' ||
        Boolean(pathname?.startsWith('/assets-api/')) ||
        pathname === '/partners' ||
        Boolean(pathname?.startsWith('/partners/'))
    );
}

function formatAgeLabel(value: string): string | null {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;

    const deltaMs = Date.now() - ms;
    if (!Number.isFinite(deltaMs)) return null;

    const minutes = Math.floor(deltaMs / (60 * 1000));
    const hours = Math.floor(deltaMs / (60 * 60 * 1000));
    const days = Math.floor(deltaMs / (24 * 60 * 60 * 1000));

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

function isSafeHref(value: string | undefined | null): value is string {
    if (!value) return false;

    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

/** One heat map category for the feed's mini map (top assets, no variants; a few KB gzipped). */
async function fetchHeatmapMini(sectorId: string): Promise<HeatmapMiniResponse> {
    const response = await fetch(`/api/heatmap?sector=${encodeURIComponent(sectorId)}`);
    if (!response.ok) throw new Error(`Heat map request failed: ${response.status}`);
    return (await response.json()) as HeatmapMiniResponse;
}

const heatmapMiniQueryKey = (sectorId: string) => ['floating-market-feed', 'heatmap', sectorId] as const;

interface FloatingMarketFeedResponse {
    items?: CoinGeckoNewsArticle[];
}

function getQueryErrorMessage(error: unknown): string | null {
    if (!error) return null;
    if (error instanceof Error) return error.message;
    return String(error);
}

function readFloatingMarketFeedSettings(): FloatingMarketFeedSettings {
    try {
        const raw = window.localStorage.getItem(FLOATING_MARKET_FEED_SETTINGS_KEY);
        if (!raw) return DEFAULT_FLOATING_MARKET_FEED_SETTINGS;
        return sanitizeFloatingMarketFeedSettings(JSON.parse(raw) as unknown);
    } catch {
        return DEFAULT_FLOATING_MARKET_FEED_SETTINGS;
    }
}

function persistFloatingMarketFeedSettings(settings: FloatingMarketFeedSettings) {
    try {
        window.localStorage.setItem(FLOATING_MARKET_FEED_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Ignore storage failures. The in-memory state still updates for the current session.
    }
}

function useFloatingMarketFeedSettings() {
    const [settings, setSettingsState] = React.useState<FloatingMarketFeedSettings>(
        DEFAULT_FLOATING_MARKET_FEED_SETTINGS,
    );
    const [loaded, setLoaded] = React.useState(false);

    React.useEffect(() => {
        setSettingsState(readFloatingMarketFeedSettings());
        setLoaded(true);
    }, []);

    React.useEffect(() => {
        if (!loaded) return;
        persistFloatingMarketFeedSettings(settings);
    }, [loaded, settings]);

    const setSettings = React.useCallback((patch: Partial<FloatingMarketFeedSettings>) => {
        setSettingsState(previous => resolveNextFloatingMarketFeedSettings(previous, patch));
    }, []);

    return { settings, setSettings };
}

async function fetchFloatingMarketFeed(params: {
    settings: FloatingMarketFeedSettings;
    tokenFeedCoinId?: string;
    tokenFeedTerms: string[];
}): Promise<CoinGeckoNewsArticle[]> {
    const searchParams = new URLSearchParams({
        source: getFloatingMarketFeedSource(params.settings),
        limit: String(params.settings.feedSize),
    });
    const coinId = params.tokenFeedCoinId?.trim();
    if (coinId) searchParams.set('coin_id', coinId);

    const terms = params.tokenFeedTerms.flatMap(term => {
        const trimmed = term.trim();
        return trimmed ? [trimmed] : [];
    });
    if (terms.length > 0) searchParams.set('terms', terms.join(','));

    const data = await Effect.runPromise(
        apiJson<FloatingMarketFeedResponse>({
            url: `/api/v1/news/feed?${searchParams.toString()}`,
            init: { headers: { Accept: 'application/json' } },
        }),
    );
    return Array.isArray(data.items) ? data.items : EMPTY_ARTICLES;
}

export function FloatingMarketFeed() {
    const { pageContext } = useFloatingMarketFeedContext();
    const pathname = usePathname();
    const hideFeed = shouldHideFloatingMarketFeed(pathname) || pageContext?.suppressFeed === true;
    const [open, setOpen] = React.useState(true);
    const [settingsMenuOpen, setSettingsMenuOpen] = React.useState(false);
    const { settings, setSettings } = useFloatingMarketFeedSettings();
    const rootRef = React.useRef<HTMLDivElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const tokenFeedTerms = pageContext?.tokenFeedTerms ?? EMPTY_TERMS;
    const feedTitle = getFloatingMarketFeedTitle(settings);
    const emptyNoun = getFloatingMarketFeedEmptyNoun(settings);

    const {
        data: feedArticlesData,
        isLoading: feedIsLoading,
        isError: feedHadError,
        error: feedError,
    } = useQuery({
        queryKey: [
            'floating-market-feed',
            'v1',
            settings.feedSize,
            settings.showNews,
            settings.showTweets,
            pageContext?.tokenFeedCoinId ?? '',
            tokenFeedTerms,
        ],
        queryFn: () =>
            fetchFloatingMarketFeed({
                settings,
                tokenFeedCoinId: pageContext?.tokenFeedCoinId,
                tokenFeedTerms,
            }),
        retry: shouldRetryApiQuery,
        staleTime: 60 * 1000,
        enabled: !hideFeed,
    });

    const queryClient = useQueryClient();
    const { data: heatmapMini, isError: heatmapFailed } = useQuery({
        queryKey: heatmapMiniQueryKey(settings.heatmapSector),
        queryFn: () => fetchHeatmapMini(settings.heatmapSector),
        staleTime: 60 * 1000,
        retry: 1,
        // Keep showing the current category while the next one loads.
        placeholderData: keepPreviousData,
        enabled: !hideFeed,
    });
    const nextHeatmapSector = heatmapMini
        ? getNextHeatmapSector(
              heatmapMini.sector.id,
              heatmapMini.sectors.map(sector => sector.id),
          )
        : null;
    const cycleHeatmapSector = React.useCallback(() => {
        if (!nextHeatmapSector) return;
        trackEvent('feed_heatmap_category_changed', { category: nextHeatmapSector });
        setSettings({ heatmapSector: nextHeatmapSector });
    }, [nextHeatmapSector, setSettings]);
    const prefetchNextHeatmapSector = React.useCallback(() => {
        if (!nextHeatmapSector) return;
        void queryClient.prefetchQuery({
            queryKey: heatmapMiniQueryKey(nextHeatmapSector),
            queryFn: () => fetchHeatmapMini(nextHeatmapSector),
            staleTime: 60 * 1000,
        });
    }, [nextHeatmapSector, queryClient]);

    const articles = feedArticlesData ?? EMPTY_ARTICLES;
    const hadError = feedHadError;
    const errorMessage = getQueryErrorMessage(feedError);
    const displayName = pageContext?.displayName ?? 'Markets';
    const feedIsPending = articles.length === 0 && feedIsLoading && !hadError;
    const isTokenContext = Boolean(pageContext?.tokenFeedCoinId || tokenFeedTerms.length > 0);

    React.useEffect(() => {
        if (!open || hideFeed) return;

        function handlePointerDown(event: PointerEvent) {
            if (settingsMenuOpen) return;

            const target = event.target;
            if (!(target instanceof Node)) return;
            if (rootRef.current?.contains(target)) return;
            if (target instanceof Element && target.closest('[data-floating-market-feed-menu]')) return;
            setOpen(false);
        }

        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [hideFeed, open, settingsMenuOpen]);

    if (hideFeed) return null;

    return (
        <LazyMotion features={domAnimation}>
            <div
                ref={rootRef}
                className={cn(
                    'tokens-floating-market-feed fixed right-4 z-40 hidden max-w-[calc(100vw-2rem)] flex-col items-end sm:right-6 sm:flex lg:right-8',
                    pageContext?.hasMobileBottomBar
                        ? 'bottom-[calc(5.75rem+env(safe-area-inset-bottom))] lg:bottom-6'
                        : 'bottom-6',
                )}
            >
                <button
                    type="button"
                    aria-label={open ? 'Collapse market feed' : 'Expand market feed'}
                    aria-expanded={open}
                    onClick={() => {
                        trackEvent('feed_toggled', { expanded: !open });
                        setOpen(value => !value);
                    }}
                    className={cn(
                        'inline-flex h-10 items-center justify-center overflow-hidden rounded-full border border-border-light bg-border-light/50 text-text-high shadow-[0_14px_36px_rgba(20,20,21,0.12)] backdrop-blur transition-[width,transform,background-color,border-color] duration-150 ease-out motion-reduce:transition-[transform,background-color,border-color] hover:border-border-medium hover:bg-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-pointer',
                        open ? 'w-10 px-0' : 'w-[156px] gap-2 px-4',
                    )}
                >
                    {open ? (
                        <ChevronDown
                            className="size-4 animate-in fade-in duration-150 motion-reduce:animate-none"
                            aria-hidden
                        />
                    ) : (
                        <span className="flex items-center gap-2 animate-in fade-in duration-150 motion-reduce:animate-none">
                            <span className="shrink-0 whitespace-nowrap text-sm font-medium">{feedTitle}</span>
                            <ChevronUp className="size-4" aria-hidden />
                        </span>
                    )}
                </button>

                <AnimatePresence initial={false}>
                    {open ? (
                        <m.aside
                            key="market-feed"
                            aria-label={`${displayName} market feed`}
                            initial={
                                shouldReduceMotion ? false : { height: 0, marginTop: 0, opacity: 0, y: 8, scale: 0.98 }
                            }
                            animate={
                                shouldReduceMotion
                                    ? { opacity: 1 }
                                    : { height: 'auto', marginTop: 12, opacity: 1, y: 0, scale: 1 }
                            }
                            exit={
                                shouldReduceMotion
                                    ? { opacity: 0 }
                                    : { height: 0, marginTop: 0, opacity: 0, y: 8, scale: 0.98 }
                            }
                            transition={{ duration: 0.24, ease: [0.23, 1, 0.32, 1] }}
                            style={{ transformOrigin: 'bottom right' }}
                            className="flex w-[min(calc(100vw-2rem),24rem)] flex-col gap-3 overflow-visible"
                        >
                            <FloatingMarketBanner />
                            {heatmapFailed && !heatmapMini ? null : (
                                <HeatmapMini
                                    data={heatmapMini}
                                    onCycle={cycleHeatmapSector}
                                    onCycleIntent={prefetchNextHeatmapSector}
                                />
                            )}
                            <FloatingMarketNewsPanel
                                articles={articles}
                                hadError={hadError}
                                errorMessage={errorMessage}
                                isLoading={feedIsPending}
                                displayName={displayName}
                                isTokenContext={isTokenContext}
                                feedCoinId={pageContext?.tokenFeedCoinId}
                                tokenLogoURI={pageContext?.tokenLogoURI}
                                tokenSymbol={pageContext?.tokenSymbol}
                                title={feedTitle}
                                emptyNoun={emptyNoun}
                                settings={settings}
                                onSettingsChange={setSettings}
                                settingsMenuOpen={settingsMenuOpen}
                                onSettingsMenuOpenChange={nextOpen => {
                                    if (nextOpen) trackEvent('feed_settings_opened', { source: 'market_feed' });
                                    setSettingsMenuOpen(nextOpen);
                                }}
                            />
                        </m.aside>
                    ) : null}
                </AnimatePresence>
            </div>
        </LazyMotion>
    );
}

function MarketBannerLogo({ logoURI }: { logoURI: string }) {
    return (
        <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white text-[0.5rem] font-semibold text-[#111111] ring-1 ring-white/10">
            <Image
                src={logoURI}
                alt=""
                width={32}
                height={32}
                className="h-full w-full object-contain"
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
            />
        </div>
    );
}

function PixelatedBannerImage({ src }: { src: string }) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const shouldReduceMotion = useReducedMotion();
    const maskImage = 'radial-gradient(ellipse 82% 118% at 78% 50%, #000 0%, #000 48%, transparent 78%)';

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // window.Image: the DOM constructor, not the next/image component imported above.
        const image = new window.Image();
        const scratchCanvas = document.createElement('canvas');
        const scratchContext = scratchCanvas.getContext('2d');
        const context = canvas.getContext('2d');
        let animationFrame = 0;
        let currentProgress = 0;
        let hasSettled = false;
        let cancelled = false;
        let sourcePixels: ImageData | null = null;

        if (!scratchContext || !context) return;
        const activeCanvas = canvas;
        const activeContext = context;
        const activeScratchContext = scratchContext;

        function syncCanvasSize(): { width: number; height: number } | null {
            const rect = activeCanvas.getBoundingClientRect();
            const pixelRatio = window.devicePixelRatio || 1;
            const width = Math.max(1, Math.round(rect.width * pixelRatio));
            const height = Math.max(1, Math.round(rect.height * pixelRatio));

            if (activeCanvas.width !== width || activeCanvas.height !== height) {
                activeCanvas.width = width;
                activeCanvas.height = height;
            }

            return { width, height };
        }

        function getCoverCrop(width: number, height: number) {
            const imageRatio = image.naturalWidth / image.naturalHeight;
            const targetRatio = width / height;

            if (imageRatio > targetRatio) {
                const sourceWidth = image.naturalHeight * targetRatio;
                return {
                    sx: (image.naturalWidth - sourceWidth) / 2,
                    sy: 0,
                    sw: sourceWidth,
                    sh: image.naturalHeight,
                };
            }

            const sourceHeight = image.naturalWidth / targetRatio;
            return {
                sx: 0,
                sy: (image.naturalHeight - sourceHeight) / 2,
                sw: image.naturalWidth,
                sh: sourceHeight,
            };
        }

        function drawFullResolution() {
            const size = syncCanvasSize();
            if (!size) return;

            const { sx, sy, sw, sh } = getCoverCrop(size.width, size.height);
            activeContext.clearRect(0, 0, size.width, size.height);
            activeContext.imageSmoothingEnabled = true;
            activeContext.imageSmoothingQuality = 'high';
            activeContext.drawImage(image, sx, sy, sw, sh, 0, 0, size.width, size.height);
        }

        function prepareSourcePixels(size: { width: number; height: number }): ImageData {
            if (sourcePixels && scratchCanvas.width === size.width && scratchCanvas.height === size.height) {
                return sourcePixels;
            }

            const { sx, sy, sw, sh } = getCoverCrop(size.width, size.height);
            scratchCanvas.width = size.width;
            scratchCanvas.height = size.height;
            activeScratchContext.clearRect(0, 0, size.width, size.height);
            activeScratchContext.imageSmoothingEnabled = true;
            activeScratchContext.imageSmoothingQuality = 'high';
            activeScratchContext.drawImage(image, sx, sy, sw, sh, 0, 0, size.width, size.height);
            sourcePixels = activeScratchContext.getImageData(0, 0, size.width, size.height);
            return sourcePixels;
        }

        function randomForCell(x: number, y: number, seed: number): number {
            const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
            return value - Math.floor(value);
        }

        function quantizeChannel(value: number, levels: number): number {
            if (levels >= 256) return value;
            return Math.round((value / 255) * (levels - 1)) * (255 / (levels - 1));
        }

        function getColorLevels(progress: number): { red: number; green: number; blue: number } {
            if (progress < 0.36) return { red: 8, green: 8, blue: 4 }; // RGB332, roughly 8-bit color.
            if (progress < 0.7) return { red: 32, green: 64, blue: 32 }; // RGB565, roughly 16-bit color.
            if (progress < 0.92) return { red: 128, green: 128, blue: 128 };
            return { red: 256, green: 256, blue: 256 };
        }

        function drawPixelResolve(progress: number) {
            const size = syncCanvasSize();
            if (!size) return;

            const pixels = prepareSourcePixels(size);
            const data = pixels.data;
            const eased = 1 - Math.pow(1 - progress, 3);
            const basePixelSize = Math.max(2, Math.round(24 - eased * 21));
            const seed = Math.floor(progress * 18);

            activeContext.save();
            activeContext.clearRect(0, 0, size.width, size.height);
            activeContext.globalCompositeOperation = 'source-over';

            for (let y = 0; y < size.height;) {
                const rowNoise = randomForCell(0, y, seed);
                const blockHeight = Math.max(1, Math.round(basePixelSize * (0.62 + rowNoise * 0.9)));

                for (let x = 0; x < size.width;) {
                    const cellNoise = randomForCell(x, y, seed);
                    const resolveNoise = randomForCell(x, y, seed + 11);
                    const xRatio = x / size.width;
                    const waveJitter = (resolveNoise - 0.5) * 0.18;
                    const localProgress = Math.min(1, Math.max(0, progress * 1.55 - xRatio * 0.68 + waveJitter));
                    const localEased = 1 - Math.pow(1 - localProgress, 3);
                    const localPixelSize = Math.max(1, Math.round(basePixelSize * (1.42 - localEased * 0.74)));
                    const blockWidth = Math.max(1, Math.round(localPixelSize * (0.7 + cellNoise * 0.95)));
                    const colorLevels = getColorLevels(localProgress);
                    const sampleX = Math.min(size.width - 1, Math.floor(x + blockWidth / 2));
                    const sampleY = Math.min(size.height - 1, Math.floor(y + blockHeight / 2));
                    const index = (sampleY * size.width + sampleX) * 4;
                    const red = quantizeChannel(data[index] ?? 0, colorLevels.red);
                    const green = quantizeChannel(data[index + 1] ?? 0, colorLevels.green);
                    const blue = quantizeChannel(data[index + 2] ?? 0, colorLevels.blue);
                    const alpha = (data[index + 3] ?? 255) / 255;

                    activeContext.fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
                    activeContext.fillRect(x, y, blockWidth + 0.75, blockHeight + 0.75);
                    x += blockWidth;
                }

                y += blockHeight;
            }

            activeContext.restore();
        }

        function resolveImage() {
            if (shouldReduceMotion) {
                hasSettled = true;
                drawFullResolution();
                return;
            }

            const startedAt = performance.now();
            const duration = 1280;

            function tick(now: number) {
                if (cancelled) return;

                const progress = Math.min(1, (now - startedAt) / duration);
                currentProgress = progress;

                if (progress >= 1) {
                    hasSettled = true;
                    drawFullResolution();
                    return;
                }

                drawPixelResolve(progress);
                animationFrame = window.requestAnimationFrame(tick);
            }

            drawPixelResolve(0);
            animationFrame = window.requestAnimationFrame(tick);
        }

        const resizeObserver = new ResizeObserver(() => {
            if (!image.complete || image.naturalWidth === 0) return;
            sourcePixels = null;
            if (hasSettled) {
                drawFullResolution();
                return;
            }
            drawPixelResolve(currentProgress);
        });

        resizeObserver.observe(activeCanvas);
        image.onload = resolveImage;
        image.src = src;

        return () => {
            cancelled = true;
            window.cancelAnimationFrame(animationFrame);
            resizeObserver.disconnect();
            image.onload = null;
        };
    }, [shouldReduceMotion, src]);

    return (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-[62%]" aria-hidden>
            <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full opacity-95"
                style={{
                    maskImage,
                    WebkitMaskImage: maskImage,
                }}
            />
        </div>
    );
}

function MarketBannerCard({ onDismiss, surface }: { onDismiss: () => void; surface: 'market_feed' | 'mobile' }) {
    // SpaceX-specific for now — intentionally not driven by the token page context.
    const label = 'Market launch';
    const title = 'The SpaceX IPO';
    const description = 'All on Solana, venues, market details, pools, all in one place.';
    const bannerId = 'spacex_ipo';
    const bannerHref = 'https://tokens.xyz/spacex';
    const bannerSource = surface === 'mobile' ? 'mobile_market_banner' : 'market_feed_banner';

    return (
        <section className="relative min-h-[10rem] overflow-hidden rounded-[27px] bg-[#111111] p-3.5 pr-32 text-left text-white shadow-[0_22px_60px_rgba(20,20,21,0.28)]">
            <PixelatedBannerImage src="/banners/spacex-raptor.jpeg" />
            <div
                className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#111111] via-[#111111]/88 to-[#111111]/16"
                aria-hidden
            />

            <div className="relative z-10 flex min-w-0 items-center gap-3 pr-9">
                <MarketBannerLogo logoURI="/logos/prestocks/spacex.svg" />
                <div className="min-w-0 truncate text-sm font-semibold text-white/72">{label}</div>
            </div>

            <div className="relative z-10 mt-6 text-[1.6rem] font-semibold leading-tight tracking-normal text-white">
                {title}
            </div>
            <p className="relative z-10 mt-2 line-clamp-2 text-sm font-medium leading-5 text-white/64">{description}</p>

            <div className="relative z-10 mt-5 flex items-center">
                <a
                    href={bannerHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() =>
                        trackEvent('external_link_clicked', {
                            link_type: 'banner',
                            link_url: bannerHref,
                            source: bannerSource,
                            banner_id: bannerId,
                        })
                    }
                    className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-[#111111] transition-transform hover:bg-white/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 cursor-pointer"
                >
                    SpaceX on Solana
                    <ArrowUpRight className="size-4" aria-hidden />
                </a>
            </div>

            <button
                type="button"
                aria-label="Dismiss market banner"
                onClick={() => {
                    trackEvent('banner_dismissed', { banner_id: bannerId, source: bannerSource });
                    onDismiss();
                }}
                className="absolute right-5 top-5 z-10 inline-flex size-8 items-center justify-center rounded-full bg-white/12 text-white/72 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 cursor-pointer"
            >
                <X className="size-5" aria-hidden />
            </button>
        </section>
    );
}

function FloatingMarketBanner() {
    if (!SPACEX_MARKET_BANNER_ACTIVE) return null;

    return <ActiveFloatingMarketBanner />;
}

function ActiveFloatingMarketBanner() {
    const { visible, dismiss } = useMarketBannerDismissal();

    if (!visible) return null;

    return <MarketBannerCard onDismiss={dismiss} surface="market_feed" />;
}

export function MobileMarketBanner() {
    if (!SPACEX_MARKET_BANNER_ACTIVE) return null;

    return <ActiveMobileMarketBanner />;
}

function ActiveMobileMarketBanner() {
    const { pageContext } = useFloatingMarketFeedContext();
    const pathname = usePathname();
    const { visible, dismiss } = useMarketBannerDismissal();
    const hideBanner = shouldHideFloatingMarketFeed(pathname) || pageContext?.suppressFeed === true;

    if (hideBanner || !visible) return null;

    return (
        <div className="fixed inset-x-0 top-0 z-50 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:hidden">
            <MarketBannerCard onDismiss={dismiss} surface="mobile" />
        </div>
    );
}

function FloatingMarketNewsPanel({
    articles,
    hadError,
    errorMessage,
    isLoading,
    displayName,
    isTokenContext,
    feedCoinId,
    tokenLogoURI,
    tokenSymbol,
    title,
    emptyNoun,
    settings,
    onSettingsChange,
    settingsMenuOpen,
    onSettingsMenuOpenChange,
}: {
    articles: CoinGeckoNewsArticle[];
    hadError?: boolean;
    errorMessage?: string | null;
    isLoading?: boolean;
    displayName: string;
    isTokenContext: boolean;
    feedCoinId?: string;
    tokenLogoURI?: string;
    tokenSymbol?: string;
    title: string;
    emptyNoun: string;
    settings: FloatingMarketFeedSettings;
    onSettingsChange: (patch: Partial<FloatingMarketFeedSettings>) => void;
    settingsMenuOpen: boolean;
    onSettingsMenuOpenChange: (open: boolean) => void;
}) {
    return (
        <section
            aria-label={`${displayName} market news`}
            className="overflow-hidden rounded-[27px] border border-border-light/50 bg-gray-100/50 shadow-[0_22px_60px_rgba(20,20,21,0.16)] backdrop-blur-xl"
        >
            <div className="flex items-center justify-between gap-3 px-3.5 pt-2.5">
                <div className="flex min-w-0 items-center gap-1.5">
                    <ActivityFeedIcon />
                    <h2 className="min-w-0 truncate text-base font-semibold text-text-extra-high">{title}</h2>
                </div>
                <FloatingMarketFeedSettingsMenu
                    settings={settings}
                    onSettingsChange={onSettingsChange}
                    open={settingsMenuOpen}
                    onOpenChange={onSettingsMenuOpenChange}
                />
            </div>

            <div className="mt-3 max-h-[20rem] overflow-hidden rounded-[29px] border border-border-medium bg-white p-2">
                <div className="market-feed-news-scroll max-h-[calc(20rem-1rem)] overflow-y-auto scrollbar-hide">
                    <NewsFeed
                        articles={articles}
                        hadError={hadError}
                        errorMessage={errorMessage}
                        isLoading={isLoading}
                        displayName={displayName}
                        isTokenContext={isTokenContext}
                        feedCoinId={feedCoinId}
                        tokenLogoURI={tokenLogoURI}
                        tokenSymbol={tokenSymbol}
                        emptyNoun={emptyNoun}
                    />
                </div>
            </div>
        </section>
    );
}

function ActivityFeedIcon() {
    return (
        <span className="flex size-[18px] shrink-0 items-center justify-center text-text-extra-low" aria-hidden>
            <svg className="size-[18px]" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                    d="M13.5 11.5H25.5C26.88 11.5 28 10.38 28 9C28 7.62 26.88 6.5 25.5 6.5H13.5C12.12 6.5 11 7.62 11 9C11 10.38 12.12 11.5 13.5 11.5Z"
                    fill="currentColor"
                />
                <path
                    d="M6.5 6.5C5.12 6.5 4 7.62 4 9C4 10.38 5.12 11.5 6.5 11.5C7.88 11.5 9 10.38 9 9C9 7.62 7.88 6.5 6.5 6.5Z"
                    fill="currentColor"
                />
                <path
                    d="M6.5 13.5C5.12 13.5 4 14.62 4 16C4 17.38 5.12 18.5 6.5 18.5C7.88 18.5 9 17.38 9 16C9 14.62 7.88 13.5 6.5 13.5Z"
                    fill="currentColor"
                />
                <path
                    d="M6.5 20.5C5.12 20.5 4 21.62 4 23C4 24.38 5.12 25.5 6.5 25.5C7.88 25.5 9 24.38 9 23C9 21.62 7.88 20.5 6.5 20.5Z"
                    fill="currentColor"
                />
                <path
                    d="M13.5 18.5H25.5C26.88 18.5 28 17.38 28 16C28 14.62 26.88 13.5 25.5 13.5H13.5C12.12 13.5 11 14.62 11 16C11 17.38 12.12 18.5 13.5 18.5Z"
                    fill="currentColor"
                />
                <path
                    d="M13.5 25.5H25.5C26.88 25.5 28 24.38 28 23C28 21.62 26.88 20.5 25.5 20.5H13.5C12.12 20.5 11 21.62 11 23C11 24.38 12.12 25.5 13.5 25.5Z"
                    fill="currentColor"
                />
            </svg>
        </span>
    );
}

function FloatingMarketFeedSettingsMenu({
    settings,
    onSettingsChange,
    open,
    onOpenChange,
}: {
    settings: FloatingMarketFeedSettings;
    onSettingsChange: (patch: Partial<FloatingMarketFeedSettings>) => void;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Feed settings"
                    title="Feed settings"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border-light bg-white/70 text-text-medium shadow-[0_1px_2px_rgba(20,20,21,0.08)] transition-[transform,background-color,border-color,color] duration-150 ease-out hover:border-border-medium hover:bg-white hover:text-text-extra-high active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-pointer"
                >
                    <Settings2 className="size-4" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                sideOffset={8}
                data-floating-market-feed-menu
                className="w-48 rounded-2xl border-border-light bg-white p-1.5 shadow-[0_18px_48px_rgba(20,20,21,0.16)]"
            >
                <TooltipProvider delayDuration={200}>
                    <FloatingMarketFeedPullCycle
                        feedSize={settings.feedSize}
                        onCycle={() => {
                            const nextSize = getNextFloatingMarketFeedSize(settings.feedSize);
                            trackEvent('feed_size_changed', { size: nextSize });
                            onSettingsChange({ feedSize: nextSize });
                        }}
                    />
                    <DropdownMenuSeparator className="my-1 bg-border-extra-light" />
                    <DropdownMenuLabel className="px-2 py-1.5 text-[0.7rem] font-semibold uppercase tracking-normal text-text-extra-low">
                        Sources
                    </DropdownMenuLabel>
                    <FloatingMarketFeedSwitchRow
                        label="News"
                        checked={settings.showNews}
                        onCheckedChange={checked => {
                            trackEvent('feed_source_toggled', { feed_source: 'news', enabled: checked });
                            onSettingsChange({ showNews: checked });
                        }}
                    />
                    <FloatingMarketFeedSwitchRow
                        label="@tokens"
                        checked={settings.showTweets}
                        onCheckedChange={checked => {
                            trackEvent('feed_source_toggled', { feed_source: 'tokens', enabled: checked });
                            onSettingsChange({ showTweets: checked });
                        }}
                    />
                </TooltipProvider>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function FloatingMarketFeedPullCycle({
    feedSize,
    onCycle,
}: {
    feedSize: FloatingMarketFeedSettings['feedSize'];
    onCycle: () => void;
}) {
    return (
        <div className="flex min-h-10 w-full items-center gap-3 rounded-xl px-2 py-1.5">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text-medium">
                Pull
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            aria-label="What pull means"
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-text-extra-low transition-colors hover:text-text-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-help"
                        >
                            <Info className="size-3.5" aria-hidden />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent
                        side="top"
                        align="center"
                        className="max-w-48 rounded-xl bg-[#111111] px-3 py-2 text-xs leading-4 text-white shadow-[0_10px_30px_rgba(20,20,21,0.18)]"
                    >
                        Sets how many feed items are requested.
                    </TooltipContent>
                </Tooltip>
            </span>
            <button
                type="button"
                aria-label={`Pull ${feedSize} items. Click to choose the next amount.`}
                onClick={onCycle}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-[transform,background-color] duration-150 ease-out hover:bg-gray-50 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium cursor-pointer"
            >
                <span className="shrink-0 text-sm font-semibold text-text-extra-high">{feedSize} items</span>
                <span className="flex shrink-0 flex-col items-center gap-1" aria-hidden>
                    {FLOATING_MARKET_FEED_SIZE_OPTIONS.map(option => (
                        <span
                            key={option}
                            className={cn(
                                'size-1 rounded-full transition-colors',
                                option === feedSize ? 'bg-text-high' : 'bg-border-medium',
                            )}
                        />
                    ))}
                </span>
            </button>
        </div>
    );
}

function FloatingMarketFeedSwitchRow({
    label,
    checked,
    onCheckedChange,
}: {
    label: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    const id = React.useId();

    return (
        <div className="flex min-h-10 items-center justify-between gap-3 rounded-xl px-2 py-1.5">
            <label htmlFor={id} className="text-sm font-medium text-text-high">
                {label}
            </label>
            <Switch
                id={id}
                checked={checked}
                onCheckedChange={onCheckedChange}
                className="data-[state=checked]:bg-[#111111] data-[state=unchecked]:bg-gray-200"
            />
        </div>
    );
}

function NewsThumbnail({ src }: { src: string }) {
    const [hasError, setHasError] = React.useState(false);

    if (hasError) return null;

    return (
        <Image
            src={src}
            alt=""
            width={56}
            height={56}
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setHasError(true)}
        />
    );
}

function NewsFeed({
    articles,
    hadError,
    errorMessage,
    isLoading,
    displayName,
    isTokenContext,
    feedCoinId,
    tokenLogoURI,
    tokenSymbol,
    emptyNoun,
}: {
    articles: CoinGeckoNewsArticle[];
    hadError?: boolean;
    errorMessage?: string | null;
    isLoading?: boolean;
    displayName: string;
    isTokenContext: boolean;
    feedCoinId?: string;
    tokenLogoURI?: string;
    tokenSymbol?: string;
    emptyNoun: string;
}) {
    if (hadError) {
        return (
            <div className="px-2 py-8 text-sm text-text-low">
                <div>Couldn&apos;t load {emptyNoun} right now.</div>
                {process.env.NODE_ENV !== 'production' && errorMessage ? (
                    <div className="mt-2 break-words text-xs text-text-extra-low">{errorMessage}</div>
                ) : null}
            </div>
        );
    }

    if (isLoading) {
        return <NewsFeedSkeleton />;
    }

    if (articles.length === 0) {
        return (
            <NewsFeedEmptyState
                displayName={displayName}
                isTokenContext={isTokenContext}
                tokenLogoURI={tokenLogoURI}
                tokenSymbol={tokenSymbol}
                emptyNoun={emptyNoun}
            />
        );
    }

    return (
        <ul className="divide-y divide-border-extra-light">
            {articles.map((article, index) => {
                const age = formatAgeLabel(article.posted_at);
                const meta = [article.source_name, age].filter(Boolean).join(' • ');
                const imageSrc = isSafeHref(article.image) ? article.image : null;

                return (
                    <li key={`${article.url}:${article.posted_at}`}>
                        <a
                            href={article.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            onClick={() =>
                                trackEvent('external_link_clicked', {
                                    link_type: 'news',
                                    link_url: article.url,
                                    source: 'market_feed',
                                    rank: index + 1,
                                    is_token_context: isTokenContext,
                                    ...(article.title ? { article_title: article.title } : {}),
                                    ...(article.source_name ? { article_source: article.source_name } : {}),
                                    ...(feedCoinId ? { coin_id: feedCoinId } : {}),
                                    ...(tokenSymbol ? { token_symbol: tokenSymbol } : {}),
                                })
                            }
                            className="group flex min-w-0 gap-3 rounded-[25px] p-2 transition-colors hover:bg-gray-50 focus-visible:bg-sand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-medium"
                        >
                            <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-sand-200 ring-1 ring-border-light">
                                {imageSrc ? <NewsThumbnail src={imageSrc} /> : null}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 text-sm font-medium leading-5 text-text-extra-high underline-offset-2 group-hover:underline">
                                    {article.title}
                                </div>
                                {meta ? <div className="mt-1 truncate text-xs text-text-extra-low">{meta}</div> : null}
                            </div>
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}

function NewsFeedEmptyState({
    displayName,
    isTokenContext,
    tokenLogoURI,
    tokenSymbol,
    emptyNoun,
}: {
    displayName: string;
    isTokenContext: boolean;
    tokenLogoURI?: string;
    tokenSymbol?: string;
    emptyNoun: string;
}) {
    return (
        <div className="flex h-full min-h-[12rem] flex-col items-center justify-center px-6 py-10 text-center">
            <NewsEmptyIcon />
            {isTokenContext ? (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5 text-sm font-medium text-gray-300">
                    <span>No recent</span>
                    <TokenEmptyStatePill displayName={displayName} logoURI={tokenLogoURI} symbol={tokenSymbol} />
                    <span>{emptyNoun} available.</span>
                </div>
            ) : (
                <div className="mt-4 text-sm font-medium text-gray-300">No recent {emptyNoun} available.</div>
            )}
        </div>
    );
}

function TokenEmptyStatePill({
    displayName,
    logoURI,
    symbol,
}: {
    displayName: string;
    logoURI?: string;
    symbol?: string;
}) {
    const label = symbol?.trim() || displayName;

    return (
        <span className="inline-flex max-w-36 items-center gap-1.5 rounded-full border border-border-light bg-transparent px-2 py-1 align-middle text-xs font-medium text-text-medium">
            {logoURI ? (
                <Image
                    src={logoURI}
                    alt=""
                    width={16}
                    height={16}
                    className="size-4 shrink-0 rounded-full bg-gray-50 object-cover"
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                />
            ) : null}
            <span className="truncate">{label}</span>
        </span>
    );
}

function NewsEmptyIcon() {
    return (
        <svg
            width="40"
            height="40"
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
            className="text-gray-300"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M6.63 6.20C3.43 7.33 3.04 12.77 6.07 13.91C6.98 14.25 7.10 14.49 6.77 15.31C3.97 22.34 8.06 28 15.95 28C23.69 28 27.58 22.95 25.34 15.81C24.89 14.39 24.94 14.24 26.00 13.84C28.37 12.96 28.60 9.04 26.41 6.91C24.83 5.37 22.77 5.80 20.95 8.06C20.24 8.94 19.98 9.02 19.18 8.61C18.38 8.20 16.78 7.80 15.95 7.80C15.12 7.80 13.53 8.20 12.73 8.61C11.93 9.02 11.67 8.94 10.96 8.06C9.51 6.26 8.12 5.67 6.63 6.20ZM17.43 17.42C20.07 18.74 21.00 23.01 19.06 24.96C16.96 27.09 12.83 26.33 12.01 23.68C11.10 20.74 13.31 17.01 15.95 17.01C16.48 17.01 16.78 17.09 17.43 17.42ZM22.42 16.13C22.42 17.15 21.80 17.97 21.04 17.97C20.28 17.97 19.66 17.15 19.66 16.13C19.66 15.11 20.28 14.29 21.04 14.29C21.80 14.29 22.42 15.11 22.42 16.13ZM10.91 17.97C11.67 17.97 12.29 17.15 12.29 16.13C12.29 15.11 11.67 14.29 10.91 14.29C10.14 14.29 9.53 15.11 9.53 16.13C9.53 17.15 10.14 17.97 10.91 17.97Z"
                fill="currentColor"
            />
            <path
                d="M16.37 22.48C14.10 22.91 12.76 20.02 14.80 19.09C15.12 18.95 15.56 18.86 15.95 18.86C18.56 18.86 18.93 22.00 16.37 22.48Z"
                fill="currentColor"
            />
        </svg>
    );
}

function NewsFeedSkeleton() {
    return (
        <ul className="divide-y divide-border-extra-light" aria-label="Loading latest news">
            {Array.from({ length: 4 }).map((_, index) => (
                <li key={index}>
                    <div className="flex min-w-0 gap-3 rounded-[25px] p-2">
                        <Skeleton className="size-14 shrink-0 rounded-xl bg-gray-100" />
                        <div className="min-w-0 flex-1 pt-0.5">
                            <Skeleton className="h-4 w-full rounded bg-gray-100" />
                            <Skeleton className="mt-2 h-4 w-10/12 rounded bg-gray-100" />
                            <Skeleton className="mt-3 h-3 w-32 rounded bg-gray-100" />
                        </div>
                    </div>
                </li>
            ))}
        </ul>
    );
}
