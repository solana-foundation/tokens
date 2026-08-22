/* eslint-disable no-console */

/**
 * Live contract check for the v2 lists API ("lists as plugins").
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3002 API_KEY=... bun scripts/verify-lists-api-v2-contract.ts
 *
 * Only exercises reads (assets:read). Write-path checks require a lists:write
 * key and a disposable list; see docs/community-lists-provisioning.md.
 */

function looksLikeSolanaMintAddress(value: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
    assert(value !== null && typeof value === 'object', `${path} must be an object`);
}

function assertNullableString(value: unknown, path: string): void {
    if (value === null) return;
    assert(typeof value === 'string', `${path} must be a string or null`);
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

async function getJson(baseUrl: string, apiKey: string, path: string): Promise<unknown> {
    const res = await fetch(new URL(path, baseUrl), { headers: { 'x-api-key': apiKey } });
    assert(res.ok, `GET ${path} failed: HTTP ${res.status} ${await res.text().then(t => t.slice(0, 300))}`);
    return res.json();
}

function assertListSummary(list: unknown, path: string): { slug: string; curated: boolean } {
    assertObject(list, path);
    assert(typeof list.slug === 'string' && list.slug.length > 0, `${path}.slug must be a non-empty string`);
    assert(typeof list.name === 'string' && list.name.length > 0, `${path}.name must be a non-empty string`);
    assertNullableString(list.description, `${path}.description`);
    assert(typeof list.curated === 'boolean', `${path}.curated must be a boolean`);
    assertObject(list.owner, `${path}.owner`);
    assert(typeof list.tokenCount === 'number', `${path}.tokenCount must be a number`);
    return { slug: list.slug, curated: list.curated };
}

function assertListToken(token: unknown, path: string): string {
    assertObject(token, path);
    assert(
        typeof token.mint === 'string' && looksLikeSolanaMintAddress(token.mint),
        `${path}.mint must be a base58 mint address`,
    );
    assertNullableString(token.symbol, `${path}.symbol`);
    assertNullableString(token.name, `${path}.name`);
    assertNullableString(token.logoURI, `${path}.logoURI`);
    assert(typeof token.verified === 'boolean', `${path}.verified must be a boolean`);
    assert(typeof token.rank === 'number', `${path}.rank must be a number`);
    return token.mint;
}

async function verifyDiscovery(baseUrl: string, apiKey: string): Promise<string[]> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/lists');
    assertObject(body, 'lists response');
    assert(Array.isArray(body.lists), 'lists response.lists must be an array');
    const summaries = body.lists.map((list, i) => assertListSummary(list, `lists[${i}]`));

    const curatedSlugs = summaries.filter(s => s.curated).map(s => s.slug);
    for (const expected of ['majors', 'currencies', 'lsts', 'rwas', 'etfs', 'metals', 'stocks']) {
        assert(curatedSlugs.includes(expected), `discovery must include curated list '${expected}'`);
    }
    return curatedSlugs;
}

async function verifyDetail(baseUrl: string, apiKey: string, slug: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, `api/v2/lists/${slug}?limit=10`);
    assertObject(body, `detail(${slug})`);
    assert(body.slug === slug, `detail(${slug}).slug must echo the slug`);
    assert(Array.isArray(body.tokens), `detail(${slug}).tokens must be an array`);
    assert(body.tokens.length > 0, `detail(${slug}) must have at least one token`);
    for (const [i, token] of body.tokens.entries()) {
        const mint = assertListToken(token, `detail(${slug}).tokens[${i}]`);
        assert(mint.length > 0, 'mint must be non-empty');
    }
}

async function verifyCompose(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/lists/tokens?lists=majors,currencies,definitely-not-a-list');
    assertObject(body, 'compose response');
    assert(Array.isArray(body.lists), 'compose.lists must be an array');
    assert(Array.isArray(body.tokens), 'compose.tokens must be an array');
    assert(Array.isArray(body.notFound), 'compose.notFound must be an array');
    assert(
        body.notFound.includes('definitely-not-a-list'),
        'compose.notFound must report the unknown slug instead of failing',
    );

    const seen = new Set<string>();
    for (const [i, token] of body.tokens.entries()) {
        const mint = assertListToken(token, `compose.tokens[${i}]`);
        assert(!seen.has(mint), `compose union must be deduped by mint (duplicate: ${mint})`);
        seen.add(mint);
        assertObject(token, `compose.tokens[${i}]`);
        assert(Array.isArray(token.lists) && token.lists.length > 0, `compose.tokens[${i}].lists must be non-empty`);
    }

    // Missing `lists` param must 400, not fall back to any implicit union.
    const res = await fetch(new URL('api/v2/lists/tokens', baseUrl), { headers: { 'x-api-key': apiKey } });
    assert(res.status === 400, `compose without lists param must 400, got ${res.status}`);
}

async function main(): Promise<void> {
    const baseUrlRaw =
        process.env.API_BASE_URL?.trim() ??
        process.env.TOKENS_API_BASE_URL?.trim() ??
        process.env.TOKENS_API_ORIGIN?.trim() ??
        '';
    const apiKey = process.env.API_KEY?.trim() ?? process.env.TOKENS_API_KEY?.trim() ?? '';
    assert(baseUrlRaw.length > 0, 'Missing env: API_BASE_URL (example: http://localhost:3002)');
    assert(apiKey.length > 0, 'Missing env: API_KEY (or TOKENS_API_KEY)');

    const baseUrl = `${coerceBaseUrl(baseUrlRaw)}/`;

    await verifyDiscovery(baseUrl, apiKey);
    await verifyDetail(baseUrl, apiKey, 'majors');
    await verifyCompose(baseUrl, apiKey);

    console.log('Lists API v2 contract verification passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
