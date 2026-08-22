/* eslint-disable no-console */

/**
 * Live contract check for the v2 execution API.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3002 API_KEY=... bun scripts/verify-execution-api-v2-contract.ts
 *
 * Exercises GET /v2/execution/links (execution:read). The route endpoint is
 * added to this script when it ships (PR 4 of the execution stack).
 */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CBBTC_MINT = 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    assert(value !== null && typeof value === 'object', `${path} must be an object`);
}

function coerceBaseUrl(value: string): string {
    const trimmed = value.trim().replace(/\/$/, '');
    assert(trimmed.length > 0, 'API_BASE_URL must be a non-empty string');
    const hasScheme = /^https?:\/\//i.test(trimmed);
    const withScheme = hasScheme
        ? trimmed
        : trimmed.startsWith('localhost') || trimmed.startsWith('127.0.0.1')
          ? `http://${trimmed}`
          : `https://${trimmed}`;
    try {
        return new URL(withScheme).toString().replace(/\/$/, '');
    } catch {
        throw new Error(`API_BASE_URL is not a valid URL: ${value}`);
    }
}

async function getRaw(baseUrl: string, apiKey: string, path: string): Promise<Response> {
    return fetch(new URL(path, baseUrl), { headers: { 'x-api-key': apiKey } });
}

async function getJson(baseUrl: string, apiKey: string, path: string): Promise<unknown> {
    const res = await getRaw(baseUrl, apiKey, path);
    assert(res.ok, `GET ${path} failed: HTTP ${res.status} ${await res.text().then(t => t.slice(0, 300))}`);
    return res.json();
}

function assertLink(link: unknown, path: string): { id: string; url: string } {
    assertObject(link, path);
    assert(typeof link.id === 'string' && link.id.length > 0, `${path}.id must be a non-empty string`);
    assert(typeof link.name === 'string' && link.name.length > 0, `${path}.name must be a non-empty string`);
    assert(link.kind === 'swap', `${path}.kind must be "swap"`);
    assert(
        link.venueType === 'aggregator' || link.venueType === 'dex',
        `${path}.venueType must be "aggregator" or "dex"`,
    );
    assert(typeof link.url === 'string', `${path}.url must be a string`);
    try {
        new URL(link.url as string);
    } catch {
        throw new Error(`${path}.url is not a valid URL: ${String(link.url)}`);
    }
    if (link.iconUrl !== null) {
        assert(
            typeof link.iconUrl === 'string' && /^https?:\/\//.test(link.iconUrl),
            `${path}.iconUrl must be null or an absolute URL`,
        );
    }
    return { id: link.id as string, url: link.url as string };
}

function assertLinksResponse(body: unknown, label: string): { linkIds: string[]; primary: string | null } {
    assertObject(body, label);
    assert(typeof body.buyMint === 'string' && body.buyMint.length > 0, `${label}.buyMint must be a string`);
    assert(
        body.sellMint === null || typeof body.sellMint === 'string',
        `${label}.sellMint must be a string or null`,
    );
    assert(body.primary === null || typeof body.primary === 'string', `${label}.primary must be a string or null`);
    assert(Array.isArray(body.links), `${label}.links must be an array`);
    const linkIds = body.links.map((link, i) => assertLink(link, `${label}.links[${i}]`).id);
    assertObject(body.meta, `${label}.meta`);
    assert(Array.isArray(body.meta.kinds) && body.meta.kinds.includes('swap'), `${label}.meta.kinds must include swap`);
    if (typeof body.primary === 'string') {
        assert(linkIds.includes(body.primary), `${label}.primary must reference a returned link id`);
    }
    return { linkIds, primary: body.primary as string | null };
}

async function main(): Promise<void> {
    const baseUrl = coerceBaseUrl(process.env.API_BASE_URL ?? '');
    const apiKey = (process.env.API_KEY ?? '').trim();
    assert(apiKey.length > 0, 'API_KEY must be set');

    // 1. Full venue set for a mint.
    const byMint = await getJson(baseUrl, apiKey, `api/v2/execution/links?mint=${CBBTC_MINT}`);
    const { linkIds, primary } = assertLinksResponse(byMint, 'links(mint)');
    assert(linkIds.length >= 5, `expected at least 5 venues, got ${linkIds.length}`);
    assert(primary === 'titan', `expected primary=titan, got ${String(primary)}`);
    console.log(`links(mint): ${linkIds.length} venues, primary=${primary}`);

    // 2. Sell-side defaulting when buying SOL.
    const solBody = await getJson(baseUrl, apiKey, `api/v2/execution/links?mint=${SOL_MINT}`);
    assertObject(solBody, 'links(sol)');
    assert(solBody.sellMint === USDC_MINT, 'buying SOL must default the sell side to USDC');
    console.log('links(sol): sell side defaults to USDC');

    // 3. Venue filter honored; filtered-out primary is null.
    const filtered = await getJson(baseUrl, apiKey, `api/v2/execution/links?mint=${CBBTC_MINT}&venues=orca,jupiter`);
    const filteredResult = assertLinksResponse(filtered, 'links(filtered)');
    assert(
        filteredResult.linkIds.join(',') === 'jupiter,orca',
        `venues filter not honored: ${filteredResult.linkIds.join(',')}`,
    );
    assert(filteredResult.primary === null, 'primary must be null when the recommended venue is filtered out');
    console.log('links(filtered): filter honored, primary nulled');

    // 4. assetId resolution.
    const byAsset = await getJson(baseUrl, apiKey, 'api/v2/execution/links?assetId=bitcoin');
    const assetResult = assertLinksResponse(byAsset, 'links(assetId)');
    assert(assetResult.linkIds.length > 0, 'assetId=bitcoin must resolve to venues');
    console.log('links(assetId): bitcoin resolved');

    // 5. Error envelopes.
    const badVenue = await getRaw(baseUrl, apiKey, `api/v2/execution/links?mint=${CBBTC_MINT}&venues=uniswap`);
    assert(badVenue.status === 400, `unknown venue must 400, got ${badVenue.status}`);
    const badVenueBody = (await badVenue.json()) as { error?: { _tag?: string } };
    assert(badVenueBody.error?._tag === 'BadRequestError', 'unknown venue must return the BadRequestError envelope');

    const unknownAsset = await getRaw(baseUrl, apiKey, 'api/v2/execution/links?assetId=not-a-real-asset');
    assert(unknownAsset.status === 404, `unknown asset must 404, got ${unknownAsset.status}`);

    const missing = await getRaw(baseUrl, apiKey, 'api/v2/execution/links');
    assert(missing.status === 400, `missing mint/assetId must 400, got ${missing.status}`);
    console.log('links(errors): 400/404 envelopes verified');

    console.log('v2 execution API contract OK');
}

main().catch(error => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
});
