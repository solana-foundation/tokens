/* eslint-disable no-console */

import { CURATED_LIST_ORDER } from '@tokens/asset-registry/curated-lists';

const apiBaseUrl = (process.env.TOKENS_API_BASE_URL ?? '').trim().replace(/\/$/, '');
const apiKey = (process.env.TOKENS_API_KEY ?? '').trim();
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.WARM_TIMEOUT_MS ?? '', 10) || 8_000);
const maxAttempts = Math.max(1, Number.parseInt(process.env.WARM_MAX_ATTEMPTS ?? '', 10) || 5);

if (!apiBaseUrl || !apiKey) {
    console.error('TOKENS_API_BASE_URL and TOKENS_API_KEY are required');
    process.exit(1);
}

function isValidCuratedPayload(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const assets = (value as { assets?: unknown }).assets;
    if (!Array.isArray(assets) || assets.length === 0) return false;
    const withStats = assets.filter(
        item => typeof item === 'object' && item !== null && (item as { stats?: unknown }).stats != null,
    ).length;
    // Match the route's own last-good health gate. A hollow 200 must not make
    // the rollout warmer report success when no Redis entry was written.
    return withStats * 2 >= assets.length;
}

async function warmList(list: string): Promise<void> {
    let lastError = 'no attempts made';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const url = new URL(`${apiBaseUrl}/api/v1/assets/curated`);
        url.searchParams.set('list', list);
        url.searchParams.set('groupBy', 'asset');
        // Force a unique edge-cache key while leaving the canonical Redis key unchanged.
        url.searchParams.set('_warm', `${Date.now()}-${attempt}`);

        try {
            const response = await fetch(url, {
                headers: {
                    'cache-control': 'no-cache',
                    'x-api-key': apiKey,
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const payload: unknown = await response.json().catch(() => null);
            if (response.ok && isValidCuratedPayload(payload)) {
                console.log(`WARMED list=${list} attempt=${attempt}`);
                return;
            }
            lastError = `status=${response.status} validPayload=${isValidCuratedPayload(payload)}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        if (attempt < maxAttempts) await Bun.sleep(500);
    }
    throw new Error(`Failed to warm list=${list}: ${lastError}`);
}

for (const list of ['all', ...CURATED_LIST_ORDER]) {
    await warmList(list);
}

console.log(`Verified last-good payloads for ${CURATED_LIST_ORDER.length + 1} curated list keys.`);
