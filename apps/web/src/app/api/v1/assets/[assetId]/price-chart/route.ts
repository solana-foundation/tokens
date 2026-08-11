import { getAsset } from '@tokens/asset-registry';
import type { TimeInterval } from '@/lib/birdeye';
import { loadCoinGeckoIndex, resolveCoinGeckoId } from '@/lib/market-data/coingecko-index';
import { fetchPriceHistory } from '@/lib/market-data/price-history';
import { proxyPlatformError, proxyPlatformGet } from '../../_platform-proxy';

const VALID_INTERVALS: readonly TimeInterval[] = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];

function parseInterval(raw: string | null): TimeInterval {
    return VALID_INTERVALS.includes(raw as TimeInterval) ? (raw as TimeInterval) : '1H';
}

/** The chart sends an epoch-second window; CoinGecko wants a day count. */
function daysFromWindow(fromSec: number | null, toSec: number | null): number {
    if (fromSec === null || toSec === null || toSec <= fromSec) return 7;
    return Math.max(1, Math.ceil((toSec - fromSec) / (24 * 60 * 60)));
}

function parseEpochSeconds(raw: string | null): number | null {
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function resolveCoinId(assetId: string): Promise<string | null> {
    const asset = getAsset(assetId) as
        | { assetId?: string; symbol?: string; aliases?: string[]; coingeckoId?: string }
        | undefined;

    const index = await loadCoinGeckoIndex();
    return resolveCoinGeckoId(
        {
            assetId: asset?.assetId ?? assetId,
            symbol: asset?.symbol ?? '',
            aliases: asset?.aliases ?? [],
            coingeckoId: asset?.coingeckoId ?? null,
        },
        index,
    );
}

export async function GET(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
    // Prefer the platform API. It owns real OHLCV with true highs and lows, so
    // the public fallback below is only for when it is not configured/running.
    try {
        const proxied = await proxyPlatformGet(request);
        if (proxied.ok) return proxied;
    } catch {
        // fall through to the public source
    }

    const { assetId } = await context.params;
    const url = new URL(request.url);
    const interval = parseInterval(url.searchParams.get('interval'));
    const days = daysFromWindow(
        parseEpochSeconds(url.searchParams.get('from')),
        parseEpochSeconds(url.searchParams.get('to')),
    );

    try {
        const coinId = await resolveCoinId(assetId);
        if (!coinId) {
            return Response.json({ candles: [], source: 'unavailable', assetId }, { status: 200 });
        }

        const candles = await fetchPriceHistory({ coinId, interval, days });
        return Response.json({ candles, source: 'coingecko', coinId });
    } catch (error) {
        return proxyPlatformError(error);
    }
}
