import { fetchManualCuratedEntriesForList } from '@/lib/market-data/manual-assets';
import { proxyPlatformError, proxyPlatformGet } from '../_platform-proxy';

/**
 * Appends the manual (off-registry) rows for this list to the platform's own
 * response. The server render does the same thing in `fetchCuratedTokens`; this
 * covers the client-side tab switches that refetch through the proxy.
 */
async function withManualAssets(request: Request, response: Response): Promise<Response> {
    if (!response.ok) return response;

    const listId = new URL(request.url).searchParams.get('list')?.trim() ?? '';
    if (!listId) return response;

    const manual = await fetchManualCuratedEntriesForList(listId);
    if (manual.length === 0) return response;

    let payload: { assets?: unknown[] } | null;
    try {
        payload = (await response.clone().json()) as { assets?: unknown[] };
    } catch {
        // A body the proxy could not parse is passed through untouched rather
        // than dropped — the manual rows are an addition, not a requirement.
        return response;
    }
    if (!payload || !Array.isArray(payload.assets)) return response;

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');

    return new Response(JSON.stringify({ ...payload, assets: [...payload.assets, ...manual] }), {
        status: response.status,
        headers,
    });
}

export async function GET(request: Request): Promise<Response> {
    try {
        return await withManualAssets(request, await proxyPlatformGet(request));
    } catch (error) {
        return proxyPlatformError(error);
    }
}
