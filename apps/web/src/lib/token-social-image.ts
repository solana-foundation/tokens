import 'server-only';

import { ImageResponse } from 'next/og';
import React from 'react';
import sharp from 'sharp';

import { getAsset, getAssetByCoingeckoId, getVariantByMint, resolveAlias } from '@tokens/asset-registry';
import { ADVISORY_COPY, advisoryTone, type AssetAdvisory } from '@/lib/asset-advisory';
import { getOgInterFonts, OG_FONT_FAMILY_INTER } from '@/lib/og-fonts';
import { cleanTokenName, getTokenLogoURL } from '@/lib/logo-overrides';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { fetchHermesLatestPrice } from '@/lib/realtime-prices/pyth-hermes-server';
import {
    normalizeRequestedSolanaMint,
    resolveSocialAdvisory,
    resolveVariantSocialData,
    selectVariantForMint,
    type TokenSocialAssetResponse,
    type TokenSocialVariant,
} from '@/lib/token-social-image-data';

const size = { width: 1200, height: 630 };

// Advisory strip across the top of the card. Plain text only: satori cannot
// render our icon components, and the strip must survive at thumbnail size.
const OG_ADVISORY_STRIP_HEIGHT = 64;
const OG_ADVISORY_STRIP_COLOR_DESTRUCTIVE = '#dc2626';
const OG_ADVISORY_STRIP_COLOR_WARNING = '#d97706';
const OG_CONTENT_PADDING_TOP = 56;

interface CoinDoc {
    name?: string;
    symbol?: string;
    image?: { large?: string; small?: string; thumb?: string };
    coin?: {
        image?: { large?: string; small?: string; thumb?: string };
    };
}

type AssetsV1AssetResponse = TokenSocialAssetResponse;

interface OhlcvCandle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface CoinGeckoMarketChartResponse {
    prices?: Array<[number, number]>;
}

interface CoinGeckoStatsResponse {
    name?: string;
    symbol?: string;
    image?: { large?: string; small?: string; thumb?: string };
    market_data?: {
        current_price?: { usd?: number };
        price_change_percentage_24h?: number;
    };
}

interface AssetPriceChartResponse {
    candles?: OhlcvCandle[];
}

const COINGECKO_PUBLIC_API_URL = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_API_URL = 'https://pro-api.coingecko.com/api/v3';
const OG_CHART_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const OG_CHART_INTERVAL = '1H';
const OG_CHART_INTERVAL_SECONDS = 60 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOptionalText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '—') return '';
    if (trimmed === '???') return '';
    return trimmed;
}

function initialsFromSymbol(symbol: string): string {
    const clean = symbol.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length === 0) return '?';
    return clean.slice(0, 2).toUpperCase();
}

function getCoinDocImageUrl(coinDoc: CoinDoc | null): string | undefined {
    return (
        coinDoc?.image?.large ??
        coinDoc?.image?.small ??
        coinDoc?.image?.thumb ??
        coinDoc?.coin?.image?.large ??
        coinDoc?.coin?.image?.small ??
        coinDoc?.coin?.image?.thumb
    );
}

function getRequestHost(headers: Headers): string {
    const raw = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'tokens.xyz';
    const first = raw.split(',')[0]?.trim();
    return first && first.length > 0 ? first : raw.trim();
}

function guessProtocolFromHost(host: string): 'http' | 'https' {
    try {
        const hostname = new URL(`http://${host}`).hostname;
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
        return isLocalhost ? 'http' : 'https';
    } catch {
        return 'https';
    }
}

function getOrigin(headers: Headers, host: string): string {
    const forwardedProto =
        headers.get('x-forwarded-proto') ?? headers.get('x-forwarded-protocol') ?? headers.get('x-url-scheme');
    const proto = forwardedProto ?? guessProtocolFromHost(host);
    return `${proto}://${host}`;
}

function toAbsoluteUrl(url: string, origin: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('/')) return `${origin}${url}`;
    return `${origin}/${url}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    if (typeof Buffer !== 'undefined') return Buffer.from(buffer).toString('base64');

    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function inferMimeType(path: string, contentType: string | null): string {
    const known: Array<string> = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
    const normalizedHeader = (contentType ?? '').split(';')[0]?.trim() ?? '';
    if (known.includes(normalizedHeader)) return normalizedHeader;
    if (path.toLowerCase().endsWith('.svg')) return 'image/svg+xml';
    if (path.toLowerCase().endsWith('.png')) return 'image/png';
    if (path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg')) return 'image/jpeg';
    if (path.toLowerCase().endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
}

function getCoinGeckoRequestConfig(): { baseUrl: string; headers: Record<string, string> } {
    const apiKey = process.env.COINGECKO_API_KEY?.trim();
    if (apiKey) {
        return {
            baseUrl: COINGECKO_PRO_API_URL,
            headers: {
                Accept: 'application/json',
                'x-cg-pro-api-key': apiKey,
            },
        };
    }

    return {
        baseUrl: COINGECKO_PUBLIC_API_URL,
        headers: {
            Accept: 'application/json',
        },
    };
}

// ---------------------------------------------------------------------------
// Price & chart formatting
// ---------------------------------------------------------------------------

const OG_PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

function formatPriceForOg(price: number): string {
    if (!Number.isFinite(price)) return '--';
    if (price === 0) return '$0.00';
    if (price < 0.00001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(6)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    return '$' + OG_PRICE_FORMATTER.format(price);
}

function formatPercentForOg(percent: number): string {
    return Math.abs(percent).toFixed(2) + '%';
}

function computePercentChange(startPrice: number | null, latestPrice: number | null): number | null {
    if (
        typeof startPrice !== 'number' ||
        !Number.isFinite(startPrice) ||
        startPrice <= 0 ||
        typeof latestPrice !== 'number' ||
        !Number.isFinite(latestPrice) ||
        latestPrice <= 0
    ) {
        return null;
    }

    return ((latestPrice - startPrice) / startPrice) * 100;
}

/**
 * Build the chart as a standalone SVG, rasterize it to PNG via sharp, and
 * return a data:image/png;base64,… URI.  Satori (next/og) does not reliably
 * render inline SVG elements, but it handles <img src="data:…"> just fine.
 */
async function buildChartPngDataUri(
    closes: number[],
    width: number,
    height: number,
    paddingTop: number,
    paddingBottom: number,
    color: string,
    fillColor: string,
): Promise<string | null> {
    if (closes.length < 2) return null;

    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min;

    const usableHeight = height - paddingTop - paddingBottom;
    const stepX = width / (closes.length - 1);

    const points = closes.map((close, i) => {
        const x = i * stepX;
        const y =
            range === 0
                ? paddingTop + usableHeight / 2
                : paddingTop + usableHeight - ((close - min) / range) * usableHeight;
        return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
    const fillPath = `${linePath} L ${points.at(-1)!.x},${height} L ${points[0]!.x},${height} Z`;

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<defs>`,
        `  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`,
        `    <stop offset="0%" stop-color="${fillColor}"/>`,
        `    <stop offset="100%" stop-color="${fillColor}" stop-opacity="0"/>`,
        `  </linearGradient>`,
        `</defs>`,
        `<path d="${fillPath}" fill="url(#g)"/>`,
        `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>`,
        `</svg>`,
    ].join('\n');

    try {
        const pngBuf = await sharp(Buffer.from(svg)).png().toBuffer();
        return `data:image/png;base64,${pngBuf.toString('base64')}`;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function ensureOgCloses(rawCloses: number[], price: number | null): number[] {
    const closes = rawCloses.filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (closes.length >= 2) return closes;

    if (closes.length === 1) {
        const v = closes[0]!;
        // Nudge by a tiny amount so the line isn't forced to the very bottom.
        return [v, v * 1.0001];
    }

    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        return [price * 0.999, price];
    }

    // Final fallback: render a harmless generic line instead of showing no chart.
    return [1, 1.0001];
}

function sanitizeCandles(candles: OhlcvCandle[] | null | undefined): OhlcvCandle[] {
    if (!Array.isArray(candles)) return [];

    return candles
        .filter(
            c =>
                typeof c?.time === 'number' &&
                Number.isFinite(c.time) &&
                typeof c.open === 'number' &&
                Number.isFinite(c.open) &&
                c.open > 0 &&
                typeof c.high === 'number' &&
                Number.isFinite(c.high) &&
                c.high > 0 &&
                typeof c.low === 'number' &&
                Number.isFinite(c.low) &&
                c.low > 0 &&
                typeof c.close === 'number' &&
                Number.isFinite(c.close) &&
                c.close > 0,
        )
        .sort((a, b) => a.time - b.time);
}

function mergeLatestPriceIntoCandles(
    candles: OhlcvCandle[],
    latest: { priceUsd: number; publishTimeMs: number | null } | null,
): { candles: OhlcvCandle[]; appliedLivePrice: number | null } {
    if (!latest || !Number.isFinite(latest.priceUsd) || latest.priceUsd <= 0) {
        return { candles, appliedLivePrice: null };
    }
    if (!Number.isFinite(latest.publishTimeMs ?? NaN) || (latest.publishTimeMs ?? 0) <= 0) {
        return { candles, appliedLivePrice: null };
    }
    if (candles.length === 0) return { candles, appliedLivePrice: null };

    const liveTimeSec = Math.floor((latest.publishTimeMs ?? 0) / 1000);
    if (!Number.isFinite(liveTimeSec) || liveTimeSec <= 0) return { candles, appliedLivePrice: null };

    const last = candles.at(-1)!;
    const lastBucket = Math.floor(last.time / OG_CHART_INTERVAL_SECONDS);
    const liveBucket = Math.floor(liveTimeSec / OG_CHART_INTERVAL_SECONDS);
    if (liveBucket < lastBucket) return { candles, appliedLivePrice: null };

    if (liveBucket === lastBucket) {
        return {
            candles: [
                ...candles.slice(0, -1),
                {
                    ...last,
                    high: Math.max(last.high, latest.priceUsd),
                    low: Math.min(last.low, latest.priceUsd),
                    close: latest.priceUsd,
                },
            ],
            appliedLivePrice: latest.priceUsd,
        };
    }

    return {
        candles: [
            ...candles,
            {
                time: liveTimeSec,
                open: last.close,
                high: Math.max(last.close, latest.priceUsd),
                low: Math.min(last.close, latest.priceUsd),
                close: latest.priceUsd,
                volume: 0,
            },
        ],
        appliedLivePrice: latest.priceUsd,
    };
}

async function fetchCoinGeckoCoinData(
    id: string,
): Promise<{ coinDoc: CoinDoc | null; stats: { price: number | null; priceChange24h: number | null } | null }> {
    try {
        const { baseUrl, headers } = getCoinGeckoRequestConfig();
        const url = new URL(`${baseUrl}/coins/${encodeURIComponent(id)}`);
        url.searchParams.set('localization', 'false');
        url.searchParams.set('tickers', 'false');
        url.searchParams.set('community_data', 'false');
        url.searchParams.set('developer_data', 'false');
        url.searchParams.set('sparkline', 'false');

        const res = await fetch(url, {
            headers,
            cache: 'no-store',
        });
        if (!res.ok) return { coinDoc: null, stats: null };
        const json: unknown = await res.json().catch(() => null);
        if (!json || typeof json !== 'object' || Array.isArray(json)) return { coinDoc: null, stats: null };

        const marketData = (json as CoinGeckoStatsResponse).market_data;
        const price = marketData?.current_price?.usd;
        const priceChange24h = marketData?.price_change_percentage_24h;

        return {
            coinDoc: json as CoinDoc,
            stats: {
                price: typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null,
                priceChange24h:
                    typeof priceChange24h === 'number' && Number.isFinite(priceChange24h) ? priceChange24h : null,
            },
        };
    } catch {
        return { coinDoc: null, stats: null };
    }
}

async function fetchAssetsV1Asset(
    origin: string,
    assetRef: string,
    mint?: string | null,
): Promise<AssetsV1AssetResponse | null> {
    try {
        const url = new URL(`${origin}/api/v1/assets/${encodeURIComponent(assetRef)}`);
        const normalizedMint = normalizeRequestedSolanaMint(mint);
        if (normalizedMint) url.searchParams.set('mint', normalizedMint);

        const res = await fetch(url, {
            next: { revalidate: 60 },
        });
        if (!res.ok) return null;
        const json: unknown = await res.json().catch(() => null);
        if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
        return json as AssetsV1AssetResponse;
    } catch {
        return null;
    }
}

async function fetchCanonicalChartForOg(assetId: string): Promise<OhlcvCandle[]> {
    const now = Math.floor(Date.now() / 1000);
    const from = now - OG_CHART_WINDOW_SECONDS;
    const params = new URLSearchParams({
        interval: OG_CHART_INTERVAL,
        from: String(from),
        to: String(now),
    });
    const data = await fetchApiAppJsonOrNull<AssetPriceChartResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId)}/price-chart?${params.toString()}`,
        {
            cache: 'no-store',
        },
    );

    return sanitizeCandles(data?.candles);
}

async function fetchVariantOhlcvForOg(assetId: string, mint: string): Promise<OhlcvCandle[]> {
    const now = Math.floor(Date.now() / 1000);
    const from = now - OG_CHART_WINDOW_SECONDS;
    const params = new URLSearchParams({
        mint,
        interval: OG_CHART_INTERVAL,
        from: String(from),
        to: String(now),
    });
    const data = await fetchApiAppJsonOrNull<AssetPriceChartResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId)}/ohlcv?${params.toString()}`,
        {
            cache: 'no-store',
        },
    );

    return sanitizeCandles(data?.candles);
}

async function fetchOhlcvForOg(coinId: string, interval: '1H' | '4H'): Promise<OhlcvCandle[]> {
    const now = Math.floor(Date.now() / 1000);
    const from = now - OG_CHART_WINDOW_SECONDS;
    const params = new URLSearchParams({
        id: coinId,
        interval,
        from: String(from),
        to: String(now),
    });
    const data = await fetchApiAppJsonOrNull<OhlcvCandle[]>(`/api/coingecko/ohlcv?${params.toString()}`, {
        cache: 'no-store',
    });
    return sanitizeCandles(data);
}

function downsampleSeries(points: number[], maxPoints: number): number[] {
    if (points.length <= maxPoints) return points;

    const lastIndex = points.length - 1;
    return Array.from({ length: maxPoints }, (_, index) => {
        const pointIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
        return points[pointIndex]!;
    });
}

async function fetchDirectChartPricesForOg(coinId: string): Promise<number[]> {
    try {
        const { baseUrl, headers } = getCoinGeckoRequestConfig();
        const url = new URL(`${baseUrl}/coins/${encodeURIComponent(coinId)}/market_chart`);
        url.searchParams.set('vs_currency', 'usd');
        url.searchParams.set('days', '7');
        url.searchParams.set('interval', 'hourly');
        url.searchParams.set('precision', 'full');

        const res = await fetch(url, {
            headers,
            cache: 'no-store',
        });
        if (!res.ok) return [];

        const json: unknown = await res.json().catch(() => null);
        if (!json || typeof json !== 'object' || Array.isArray(json)) return [];

        const prices: Array<[number, number]> = Array.isArray((json as CoinGeckoMarketChartResponse).prices)
            ? ((json as CoinGeckoMarketChartResponse).prices as Array<[number, number]>)
            : [];

        return prices
            .map(entry => (Array.isArray(entry) && typeof entry[1] === 'number' ? entry[1] : null))
            .filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 0);
    } catch {
        return [];
    }
}

async function inlineLocalLogoAsDataUrl(logoSrc: string, origin: string): Promise<string | null> {
    if (!logoSrc.startsWith('/')) return null;

    const absolute = toAbsoluteUrl(logoSrc, origin);
    try {
        const res = await fetch(absolute, { next: { revalidate: 60 } });
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        const base64 = arrayBufferToBase64(bytes);
        const mime = inferMimeType(logoSrc, res.headers.get('content-type'));
        return `data:${mime};base64,${base64}`;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Brand logo SVG path (4-dot logo from logo.tsx)
// ---------------------------------------------------------------------------

const BRAND_LOGO_PATH =
    'M106 127.2C129.417 127.2 148.4 146.183 148.4 169.6C148.4 193.016 129.417 212 106 212C82.5831 212 63.5996 193.016 63.5996 169.6C63.5998 146.183 82.5833 127.2 106 127.2ZM42.4004 63.5996C65.8171 63.5998 84.7998 82.5833 84.7998 106C84.7998 129.417 65.8171 148.4 42.4004 148.4C18.9835 148.4 0 129.417 0 106C0 82.5831 18.9835 63.5996 42.4004 63.5996ZM169.6 63.5996C193.016 63.5996 212 82.5831 212 106C212 129.417 193.016 148.4 169.6 148.4C146.183 148.4 127.2 129.417 127.2 106C127.2 82.5833 146.183 63.5998 169.6 63.5996ZM106 0C129.417 0 148.4 18.9835 148.4 42.4004C148.4 65.8171 129.417 84.7998 106 84.7998C82.5833 84.7998 63.5998 65.8171 63.5996 42.4004C63.5996 18.9835 82.5831 0 106 0Z';
const TREND_TRIANGLE_PATH =
    'M15.5371 14.7656C15.5371 14.375 15.3613 14.0625 15.1562 13.6523L9.07227 1.11328C8.66211 0.273438 8.28125 0.00976562 7.76367 0.00976562C7.24609 0.00976562 6.875 0.273438 6.46484 1.11328L0.371094 13.6523C0.175781 14.0723 0 14.3848 0 14.7754C0 15.498 0.546875 15.9473 1.39648 15.9473L14.1309 15.9375C14.9805 15.9375 15.5371 15.4883 15.5371 14.7656Z';

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getTokenSocialImageResponse(request: Request, name: string): Promise<Response> {
    try {
        // Next's image optimizer hardens the process-wide sharp instance by
        // blocking every libvips loader except bitmap formats (see getSharp()
        // in next/dist/server/image-optimizer.js), which also breaks SVG
        // rasterization here: both our chart PNG and ImageResponse itself
        // (@vercel/og rasterizes satori's SVG via sharp when it's installed)
        // start throwing "Input buffer contains unsupported image format" as
        // soon as any next/image optimization has run in this process. The
        // SVG buffers in this route are exclusively self-generated (satori
        // output + our own chart markup), never user-supplied, so re-enable
        // the SVG loader per render — after the optimizer's one-time block.
        sharp.unblock({ operation: ['VipsForeignLoadSvg'] });
        const requestedName = name.trim();
        const requestHost = getRequestHost(request.headers);
        const origin = getOrigin(request.headers, requestHost);

        const requestedMint = normalizeRequestedSolanaMint(new URL(request.url).searchParams.get('solana'));
        const assetFromName =
            getAssetByCoingeckoId(requestedName) ?? resolveAlias(requestedName) ?? getAsset(requestedName);
        const asset = assetFromName ?? (requestedMint ? (getVariantByMint(requestedMint)?.asset ?? null) : null);

        let displayName = cleanTokenName(asset?.name ?? requestedName);
        let symbol = normalizeOptionalText(asset?.symbol).toUpperCase() || requestedName.toUpperCase();

        let coingeckoId: string | null = normalizeOptionalText(asset?.coingeckoId) || null;
        let fallbackLogoURI: string | undefined;
        let apiAsset: AssetsV1AssetResponse | null = null;
        let selectedVariant: TokenSocialVariant | null = null;
        let socialAdvisory: AssetAdvisory | null = null;

        if (asset) {
            apiAsset = await fetchAssetsV1Asset(origin, asset.assetId, requestedMint);
            selectedVariant = requestedMint ? selectVariantForMint(apiAsset?.asset.variantGroups, requestedMint) : null;
            if (requestedMint && !selectedVariant) {
                apiAsset = await fetchAssetsV1Asset(origin, asset.assetId);
            }
            socialAdvisory = resolveSocialAdvisory({
                selectedVariant,
                primaryVariant: apiAsset?.asset.primaryVariant ?? null,
            });

            const apiDisplayName =
                normalizeOptionalText(apiAsset?.asset.name) ||
                normalizeOptionalText(apiAsset?.asset.primaryVariant?.name);
            const apiSymbol =
                normalizeOptionalText(apiAsset?.asset.symbol) ||
                normalizeOptionalText(apiAsset?.asset.primaryVariant?.symbol);

            displayName = cleanTokenName(apiDisplayName || asset.name || requestedName);
            symbol = (apiSymbol || normalizeOptionalText(asset.symbol)).toUpperCase() || symbol;
            coingeckoId = normalizeOptionalText(apiAsset?.asset.coingeckoId) || coingeckoId;
            fallbackLogoURI = apiAsset?.asset.primaryVariant?.market?.logoURI ?? undefined;
        }

        // Only look up CoinGecko for a resolved coingecko id. Previously an
        // unresolved request fell back to the raw route segment, letting anyone
        // drive arbitrary (billed, cache-bypassing) CoinGecko Pro calls via
        // /<random-name>/opengraph-image. Unknown names now skip the lookup.
        const coinLookupId = coingeckoId;
        const coinData = coinLookupId ? await fetchCoinGeckoCoinData(coinLookupId) : null;
        const coinDoc = coinData?.coinDoc ?? null;
        if (!asset && coinDoc) {
            if (typeof coinDoc.name === 'string') displayName = cleanTokenName(coinDoc.name);
            if (typeof coinDoc.symbol === 'string') symbol = coinDoc.symbol.toUpperCase();
        }

        if (asset && coinDoc && (!fallbackLogoURI || fallbackLogoURI.trim().length === 0)) {
            const imageUrl = getCoinDocImageUrl(coinDoc);
            fallbackLogoURI = imageUrl;
        }

        if (!asset && coinDoc) {
            const imageUrl = getCoinDocImageUrl(coinDoc);
            fallbackLogoURI = imageUrl;
        }

        // ----- Fetch price data & chart data -----
        const canonicalDisplayName = displayName;
        const canonicalSymbol = symbol;
        const canonicalLogoSrc = getTokenLogoURL(canonicalSymbol, fallbackLogoURI);
        const selectedMint = selectedVariant?.mint ?? null;
        const [variantCandles, canonicalCandles, liveSpot] = await Promise.all([
            selectedMint && asset ? fetchVariantOhlcvForOg(asset.assetId, selectedMint) : Promise.resolve([]),
            asset ? fetchCanonicalChartForOg(asset.assetId) : Promise.resolve([]),
            selectedMint ? Promise.resolve(null) : fetchHermesLatestPrice({ coingeckoId, symbol }),
        ]);
        const stats = coingeckoId ? (coinLookupId === coingeckoId ? (coinData?.stats ?? null) : null) : null;

        const hasVariantCandles = variantCandles.length > 0;
        let chartCandles = hasVariantCandles ? variantCandles : canonicalCandles;
        if (chartCandles.length === 0 && coingeckoId) {
            chartCandles = await fetchOhlcvForOg(coingeckoId, '1H');
        }
        if (chartCandles.length === 0 && coingeckoId) {
            chartCandles = await fetchOhlcvForOg(coingeckoId, '4H');
        }

        const mergedLive = mergeLatestPriceIntoCandles(chartCandles, liveSpot);
        const chartCandlesWithLive = mergedLive.candles;
        const directCloses =
            chartCandlesWithLive.length === 0 && coingeckoId ? await fetchDirectChartPricesForOg(coingeckoId) : [];
        const chartCloses =
            chartCandlesWithLive.length > 0
                ? downsampleSeries(
                      chartCandlesWithLive.map(c => c.close),
                      120,
                  )
                : downsampleSeries(directCloses, 120);

        const firstOpen = chartCandlesWithLive[0]?.open ?? null;
        const lastCandleClose = chartCandlesWithLive.at(-1)?.close ?? null;
        let price = mergedLive.appliedLivePrice ?? lastCandleClose ?? stats?.price ?? null;
        const computedPriceChange = computePercentChange(firstOpen, price);
        let priceChange = computedPriceChange ?? stats?.priceChange24h ?? null;
        let priceChangeLabel = computedPriceChange !== null ? '7D' : priceChange !== null ? '24H' : null;

        const variantLastClose = hasVariantCandles ? (variantCandles.at(-1)?.close ?? null) : null;
        const variantSevenDayChange = hasVariantCandles
            ? computePercentChange(variantCandles[0]?.open ?? null, variantLastClose)
            : null;
        const selectedSocialData = selectedVariant
            ? resolveVariantSocialData({
                  variant: selectedVariant,
                  canonicalDisplayName,
                  canonicalSymbol,
                  canonicalLogoURI: canonicalLogoSrc ?? fallbackLogoURI,
                  latestVariantClose: variantLastClose,
                  variantSevenDayChange,
                  canonicalPrice: price,
                  canonicalPriceChange: priceChange,
                  canonicalPriceChangeLabel: priceChangeLabel,
              })
            : null;

        if (selectedSocialData) {
            displayName = cleanTokenName(selectedSocialData.displayName);
            symbol = normalizeOptionalText(selectedSocialData.symbol).toUpperCase() || symbol;
            price = selectedSocialData.price;
            priceChange = selectedSocialData.priceChange;
            priceChangeLabel = selectedSocialData.priceChangeLabel;
        }

        let logoUrl: string | null = null;
        const logoSrc = selectedSocialData?.logoURI ?? getTokenLogoURL(symbol, fallbackLogoURI);
        if (logoSrc) {
            const inlined = await inlineLocalLogoAsDataUrl(logoSrc, origin);
            logoUrl = inlined ?? toAbsoluteUrl(logoSrc, origin);
        }

        const isPositive = (priceChange ?? 0) >= 0;
        const chartColor = isPositive ? '#10b981' : '#ef4444';
        const chartFillColor = isPositive ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';
        const closesForChart = ensureOgCloses(chartCloses, price);
        const chartDataUri = await buildChartPngDataUri(closesForChart, 1200, 380, 20, 0, chartColor, chartFillColor);

        const fonts = await getOgInterFonts();

        const h = React.createElement;

        const image = new ImageResponse(
            h(
                'div',
                {
                    style: {
                        width: '100%',
                        height: '100%',
                        position: 'relative',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        backgroundColor: '#ffffff',
                        color: '#111827',
                        fontFamily: `${OG_FONT_FAMILY_INTER}, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`,
                    },
                },

                // --- Layer 1: Chart background (positioned at bottom) ---
                // Pre-rasterized to PNG via sharp because Satori does not
                // reliably render inline SVG elements.
                chartDataUri
                    ? h('img', {
                          src: chartDataUri,
                          width: 1200,
                          height: 380,
                          alt: '',
                          style: {
                              position: 'absolute',
                              bottom: 0,
                              left: 0,
                              width: 1200,
                              height: 380,
                          },
                      })
                    : null,

                // --- Layer 2: Content overlay ---
                h(
                    'div',
                    {
                        style: {
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            // Push the identity row below the advisory strip when present.
                            padding: `${
                                socialAdvisory
                                    ? OG_CONTENT_PADDING_TOP + OG_ADVISORY_STRIP_HEIGHT
                                    : OG_CONTENT_PADDING_TOP
                            }px 64px ${OG_CONTENT_PADDING_TOP}px`,
                        },
                    },

                    // Top row: logo + name (left) and brand logo (right)
                    h(
                        'div',
                        {
                            style: {
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                width: '100%',
                            },
                        },
                        // Left: token logo + name
                        h(
                            'div',
                            { style: { display: 'flex', alignItems: 'center' } },
                            h(
                                'div',
                                {
                                    style: {
                                        width: 62,
                                        height: 62,
                                        borderRadius: 9999,
                                        overflow: 'hidden',
                                        backgroundColor: '#e5e7eb',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 26,
                                        fontWeight: 700,
                                        color: '#4b5563',
                                    },
                                },
                                logoUrl
                                    ? h('img', {
                                          src: logoUrl,
                                          width: 62,
                                          height: 62,
                                          alt: '',
                                          style: {
                                              width: 62,
                                              height: 62,
                                              objectFit: 'cover',
                                              borderRadius: 9999,
                                          },
                                      })
                                    : initialsFromSymbol(symbol),
                            ),
                            h(
                                'div',
                                {
                                    style: {
                                        marginLeft: 18,
                                        fontSize: 40,
                                        fontWeight: 500,
                                        color: '#111827',
                                    },
                                },
                                displayName,
                            ),
                        ),
                        // Right: brand logo
                        h(
                            'svg',
                            {
                                width: '48',
                                height: '48',
                                viewBox: '0 0 212 212',
                                xmlns: 'http://www.w3.org/2000/svg',
                            },
                            h('path', {
                                d: BRAND_LOGO_PATH,
                                fill: '#111827',
                            }),
                        ),
                    ),

                    // Price section
                    price !== null
                        ? h(
                              'div',
                              {
                                  style: {
                                      display: 'flex',
                                      flexDirection: 'column',
                                      marginTop: 24,
                                  },
                              },
                              h(
                                  'div',
                                  {
                                      style: {
                                          display: 'flex',
                                          alignItems: 'flex-end',
                                          gap: 18,
                                      },
                                  },
                                  h(
                                      'div',
                                      {
                                          style: {
                                              fontSize: 72,
                                              fontWeight: 700,
                                              lineHeight: 1.1,
                                              color: '#111827',
                                          },
                                      },
                                      formatPriceForOg(price),
                                  ),
                                  priceChange !== null
                                      ? h(
                                            'div',
                                            {
                                                style: {
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 10,
                                                    color: chartColor,
                                                    marginBottom: 6,
                                                },
                                            },
                                            h(
                                                'svg',
                                                {
                                                    width: '18',
                                                    height: '18',
                                                    viewBox: '0 0 16 16',
                                                    xmlns: 'http://www.w3.org/2000/svg',
                                                },
                                                h(
                                                    'g',
                                                    isPositive
                                                        ? null
                                                        : {
                                                              transform: 'translate(15.8984 15.9473) rotate(180)',
                                                          },
                                                    h('rect', {
                                                        width: '15.8984',
                                                        height: '15.9473',
                                                        x: '0',
                                                        y: '0',
                                                        opacity: '0',
                                                    }),
                                                    h('path', {
                                                        d: TREND_TRIANGLE_PATH,
                                                        fill: chartColor,
                                                        fillOpacity: 0.85,
                                                    }),
                                                ),
                                            ),
                                            h(
                                                'div',
                                                {
                                                    style: {
                                                        fontSize: 58,
                                                        fontWeight: 500,
                                                        lineHeight: 1,
                                                    },
                                                },
                                                formatPercentForOg(priceChange),
                                            ),
                                            priceChangeLabel
                                                ? h(
                                                      'div',
                                                      {
                                                          style: {
                                                              fontSize: 24,
                                                              fontWeight: 600,
                                                              lineHeight: 1,
                                                              letterSpacing: '0.08em',
                                                              opacity: 0.7,
                                                              marginBottom: 8,
                                                          },
                                                      },
                                                      priceChangeLabel,
                                                  )
                                                : null,
                                        )
                                      : null,
                              ),
                          )
                        : null,
                ),

                // --- Layer 3: Advisory strip (on top of everything) ---
                socialAdvisory
                    ? h(
                          'div',
                          {
                              style: {
                                  position: 'absolute',
                                  top: 0,
                                  left: 0,
                                  right: 0,
                                  height: OG_ADVISORY_STRIP_HEIGHT,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  backgroundColor:
                                      advisoryTone(socialAdvisory.status) === 'warning'
                                          ? OG_ADVISORY_STRIP_COLOR_WARNING
                                          : OG_ADVISORY_STRIP_COLOR_DESTRUCTIVE,
                                  color: '#ffffff',
                                  fontSize: 28,
                                  fontWeight: 700,
                                  letterSpacing: '0.06em',
                              },
                          },
                          ADVISORY_COPY[socialAdvisory.status].ogStrip,
                      )
                    : null,
            ),
            { ...size, ...(fonts.length > 0 ? { fonts } : {}) },
        );

        const png = await image.arrayBuffer();
        return new Response(png, {
            headers: {
                'content-type': 'image/png',
                // Bucketed URLs (minuteBucket in page metadata) change every minute, so a short
                // CDN cache dedupes satori renders without going stale.
                'cache-control': 'public, s-maxage=60, stale-while-revalidate=300',
            },
        });
    } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return new Response(message, {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
    }
}
