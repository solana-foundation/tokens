import { emitEvent } from '@tokens/effect';
const SLOW_REQUEST_THRESHOLD_MS = 1_000;

export function shouldSkipHttpMetrics(pathname: string): boolean {
    return pathname === '/api/health' || pathname === '/api/v1/health';
}

export function normalizeEndpointPath(pathname: string): string {
    const parts = pathname.split('/').filter(Boolean);

    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'assets') {
        const segment = parts[3];
        if (!segment) return '/api/v1/assets';

        if (segment === 'search') return '/api/v1/assets/search';
        if (segment === 'curated') return '/api/v1/assets/curated';
        if (segment === 'risk-summary') return '/api/v1/assets/risk-summary';

        if (parts[4] === 'risk-details') return '/api/v1/assets/:assetId/risk-details';
        if (parts[4] === 'risk-summary') return '/api/v1/assets/:assetId/risk-summary';
        if (parts[4] === 'variants') return '/api/v1/assets/:assetId/variants';
        if (parts[4] === 'description') return '/api/v1/assets/:assetId/description';
        if (parts[4] === 'tickers') return '/api/v1/assets/:assetId/tickers';
        if (parts[4] === 'price-chart') return '/api/v1/assets/:assetId/price-chart';
        if (parts[4] === 'variant-top-markets') return '/api/v1/assets/:assetId/variant-top-markets';
        if (parts[4] === 'ohlcv') return '/api/v1/assets/:assetId/ohlcv';
        if (parts[4] === 'profile') return '/api/v1/assets/:assetId/profile';
        if (parts[4] === 'variant-market') return '/api/v1/assets/:assetId/variant-market';
        if (parts[4] === 'markets') return '/api/v1/assets/:assetId/markets';
        return '/api/v1/assets/:assetId';
    }

    if (parts[0] === 'api' && parts[1] === 'token') {
        if (!parts[2]) return '/api/token';
        const suffix = parts.slice(3).join('/');
        return suffix ? `/api/token/:address/${suffix}` : '/api/token/:address';
    }

    if (parts[0] === 'api' && parts[1] === 'coingecko') {
        if (parts[2] === 'ohlcv') return '/api/coingecko/ohlcv';
        if (parts[2] === 'news') return '/api/coingecko/news';

        if (parts[2] === 'coins') {
            const segment = parts[3];
            if (!segment) return '/api/coingecko/coins';
            if (segment === 'search') return '/api/coingecko/coins/search';
            if (segment === 'stats') return '/api/coingecko/coins/stats';

            const suffix = parts.slice(4).join('/');
            return suffix ? `/api/coingecko/coins/:id/${suffix}` : '/api/coingecko/coins/:id';
        }
    }

    if (parts[0] === 'api' && parts[1] === 'tokens') {
        if (parts[2] === 'curated' && parts[3] === 'seed') return '/api/tokens/curated/seed';
        if (parts[2] === 'curated' && parts[3] === 'seed-ohlcv') return '/api/tokens/curated/seed-ohlcv';
        if (parts[2] === 'curated') return '/api/tokens/curated';
        if (parts[2] === 'search') return '/api/tokens/search';
        if (parts[2] === 'by-addresses') return '/api/tokens/by-addresses';
        if (parts[2] === 'market-snapshots') return '/api/tokens/market-snapshots';
        if (parts[2] === 'descriptions' && parts[3] === 'by-address') return '/api/tokens/descriptions/by-address';
        if (parts[2] === 'descriptions' && parts[3] === 'summarize') return '/api/tokens/descriptions/summarize';
    }

    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'whoami') return '/api/v1/whoami';
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'health') return '/api/v1/health';
    if (parts[0] === 'api' && parts[1] === 'health') return '/api/health';
    if (parts[0] === 'api' && parts[1] === 'ohlcv') return '/api/ohlcv';

    return pathname;
}

function log(entry: Record<string, unknown>) {
    emitEvent(entry);
}

export function logHttpRequest(params: {
    requestId: string;
    method: string;
    path: string | null;
    status: number;
    durationMs: number;
    timestamp?: string;
    source?: string;
    authType?: 'api_key' | 'clerk_session' | 'public';
    authFailure?: boolean;
    apiKeyId?: string;
    keyPrefix?: string;
    projectId?: string;
    scopes?: string[];
    rateLimit?: unknown;
    quota?: unknown;
}): void {
    if (!params.path || shouldSkipHttpMetrics(params.path)) return;

    log({
        event: 'http_request',
        timestamp: params.timestamp ?? new Date().toISOString(),
        request_id: params.requestId,
        method: params.method,
        path: params.path,
        endpoint: normalizeEndpointPath(params.path),
        status: params.status,
        status_class: `${Math.floor(params.status / 100)}xx`,
        duration_ms: params.durationMs,
        slow_request: params.durationMs >= SLOW_REQUEST_THRESHOLD_MS,
        source: params.source ?? 'api',
        ...(params.authType ? { auth_type: params.authType } : {}),
        ...(params.authFailure !== undefined ? { auth_failure: params.authFailure } : {}),
        ...(params.apiKeyId ? { api_key_id: params.apiKeyId } : {}),
        ...(params.keyPrefix ? { key_prefix: params.keyPrefix } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
        ...(params.scopes ? { scopes: params.scopes } : {}),
        ...(params.rateLimit ? { rate_limit: params.rateLimit } : {}),
        ...(params.quota ? { quota: params.quota } : {}),
    });
}

/**
 * Emitted when rate limiting degrades (Redis unreachable, timeout, missing
 * config) and the request proceeds un-metered (fail-open policy).
 * Alert on sustained occurrences of `event: "rate_limit_degraded"`.
 */
export function logRateLimitDegraded(params: {
    requestId: string;
    apiKeyId?: string;
    projectId?: string;
    reason: string;
}): void {
    log({
        event: 'rate_limit_degraded',
        timestamp: new Date().toISOString(),
        request_id: params.requestId,
        reason: params.reason,
        ...(params.apiKeyId ? { api_key_id: params.apiKeyId } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
    });
}

export function logUsageAggregationDegraded(params: {
    requestId: string;
    apiKeyId?: string;
    projectId?: string;
    reason: string;
}): void {
    log({
        event: 'usage_aggregation_degraded',
        timestamp: new Date().toISOString(),
        request_id: params.requestId,
        reason: params.reason,
        ...(params.apiKeyId ? { api_key_id: params.apiKeyId } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
    });
}

/**
 * Emitted per usage drain (Redis aggregates → rollup tables). `failed` means
 * dashboard usage is going stale; alert on sustained occurrences.
 */
export function logUsageDrain(params: {
    requestId: string;
    status: 'ok' | 'failed';
    ingested?: number;
    restored?: number;
    reason?: string;
}): void {
    log({
        event: 'usage_drain',
        timestamp: new Date().toISOString(),
        request_id: params.requestId,
        status: params.status,
        ...(params.ingested !== undefined ? { ingested: params.ingested } : {}),
        ...(params.restored !== undefined ? { restored: params.restored } : {}),
        ...(params.reason ? { reason: params.reason.slice(0, 500) } : {}),
    });
}

export function logApiError(params: {
    requestId: string;
    method: string;
    path: string | null;
    status: number;
    durationMs: number;
    errorType: string;
    errorMessage?: string;
    errorStack?: string;
    timestamp?: string;
    source?: string;
    authType?: 'api_key' | 'clerk_session' | 'public';
    authFailure?: boolean;
    apiKeyId?: string;
    keyPrefix?: string;
    projectId?: string;
    scopes?: string[];
    rateLimit?: unknown;
    quota?: unknown;
}): void {
    if (!params.path || shouldSkipHttpMetrics(params.path)) return;

    log({
        event: 'api_error',
        timestamp: params.timestamp ?? new Date().toISOString(),
        request_id: params.requestId,
        method: params.method,
        path: params.path,
        endpoint: normalizeEndpointPath(params.path),
        status: params.status,
        status_class: `${Math.floor(params.status / 100)}xx`,
        duration_ms: params.durationMs,
        error_type: params.errorType,
        ...(params.errorMessage ? { error_message: params.errorMessage.slice(0, 500) } : {}),
        ...(params.errorStack ? { error_stack: params.errorStack.slice(0, 2000) } : {}),
        slow_request: params.durationMs >= SLOW_REQUEST_THRESHOLD_MS,
        source: params.source ?? 'api',
        ...(params.authType ? { auth_type: params.authType } : {}),
        ...(params.authFailure !== undefined ? { auth_failure: params.authFailure } : {}),
        ...(params.apiKeyId ? { api_key_id: params.apiKeyId } : {}),
        ...(params.keyPrefix ? { key_prefix: params.keyPrefix } : {}),
        ...(params.projectId ? { project_id: params.projectId } : {}),
        ...(params.scopes ? { scopes: params.scopes } : {}),
        ...(params.rateLimit ? { rate_limit: params.rateLimit } : {}),
        ...(params.quota ? { quota: params.quota } : {}),
    });
}
