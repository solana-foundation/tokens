import {
    daysFromWindow,
    fetchAssetCandles,
    parseEpochSeconds,
    parseInterval,
} from '@/lib/market-data/asset-ohlcv';
import { proxyPlatformError, proxyPlatformGet } from '../_platform-proxy';

/**
 * The inline sparklines on the homepage read candles from this route with
 * `?include=ohlcv`. Without the platform API behind it every one of those
 * requests 500s and the table renders a row of flat lines, so that one include
 * is answered from public market data instead. Every other shape of this
 * request still belongs to the platform API and is passed through untouched.
 */

function requestsOhlcvInclude(url: URL): boolean {
    return (url.searchParams.get('include') ?? '')
        .split(',')
        .map(part => part.trim())
        .includes('ohlcv');
}

export async function GET(
    request: Request,
    context: { params: Promise<{ assetId: string }> },
): Promise<Response> {
    let proxied: Response | null = null;
    let proxyError: unknown = null;
    try {
        proxied = await proxyPlatformGet(request);
        if (proxied.ok) return proxied;
    } catch (error) {
        proxyError = error;
    }

    const url = new URL(request.url);
    if (!requestsOhlcvInclude(url)) {
        // Nothing to substitute: hand back the upstream status, or report the
        // transport failure the way this route always has.
        return proxied ?? proxyPlatformError(proxyError);
    }

    const { assetId } = await context.params;
    const interval = parseInterval(url.searchParams.get('ohlcvInterval'));
    const days = daysFromWindow(
        parseEpochSeconds(url.searchParams.get('ohlcvFrom')),
        parseEpochSeconds(url.searchParams.get('ohlcvTo')),
    );

    try {
        const { candles, source, coinId } = await fetchAssetCandles({ assetId, interval, days });
        // An unresolvable asset (most equities have no CoinGecko counterpart)
        // returns an empty series rather than `ok: false` — the sparkline then
        // renders nothing instead of surfacing an error the user cannot act on.
        return Response.json({
            assetId,
            source,
            ...(coinId ? { coinId } : {}),
            includes: { ohlcv: { ok: true, data: candles } },
        });
    } catch (error) {
        return proxyPlatformError(error);
    }
}
