import {
    daysFromWindow,
    fetchAssetCandles,
    parseEpochSeconds,
    parseInterval,
} from '@/lib/market-data/asset-ohlcv';
import { proxyPlatformError, proxyPlatformGet } from '../../_platform-proxy';

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
        const { candles, source, coinId } = await fetchAssetCandles({ assetId, interval, days });
        return Response.json({ candles, source, ...(coinId ? { coinId } : { assetId }) });
    } catch (error) {
        return proxyPlatformError(error);
    }
}
