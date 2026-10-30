/* eslint-disable no-console */

/**
 * Live contract check for the v2 API: lists ("lists as plugins"), the public
 * judged search (`/v2/search`, `/v2/resolve`) and the asset registry
 * (`/v2/registry`).
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
    // Read the body only on failure: the template literal below would otherwise
    // consume it eagerly and the res.json() that follows would throw.
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GET ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
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
    // `advisory` is always present: null, or an active non-blocked advisory
    // (blocked mints are hidden from list hydration).
    assert('advisory' in token, `${path}.advisory must exist (null allowed)`);
    if (token.advisory !== null) {
        assertObject(token.advisory, `${path}.advisory`);
        assert(
            token.advisory.status === 'caution' || token.advisory.status === 'compromised',
            `${path}.advisory.status must be caution|compromised (blocked is hidden from lists)`,
        );
        assert(typeof token.advisory.reason === 'string', `${path}.advisory.reason must be a string`);
        assertNullableString(token.advisory.url, `${path}.advisory.url`);
        assert(typeof token.advisory.since === 'number', `${path}.advisory.since must be a number`);
    }
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

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RESOLVE_STATUSES = new Set(['resolved', 'ambiguous', 'no_confident_match']);

function assertJudgedToken(token: unknown, path: string): string {
    assertObject(token, path);
    assert(
        typeof token.mint === 'string' && looksLikeSolanaMintAddress(token.mint),
        `${path}.mint must be a base58 mint address`,
    );
    assert(typeof token.verified === 'boolean', `${path}.verified must be a boolean`);
    assert(Array.isArray(token.reasons), `${path}.reasons must be an array`);
    assert(Array.isArray(token.warnings), `${path}.warnings must be an array`);
    assert(Array.isArray(token.badges), `${path}.badges must be an array`);
    assertObject(token.score, `${path}.score`);
    assert(typeof token.score.total === 'number', `${path}.score.total must be a number`);
    return token.mint;
}

function assertJudgedEnvelope(body: Record<string, unknown>, path: string, expectedPolicy: string): void {
    assert(body.query === 'USDC', `${path}.query must echo q`);
    assertObject(body.interpretation, `${path}.interpretation`);
    assertObject(body.policy, `${path}.policy`);
    assert(body.policy.id === expectedPolicy, `${path}.policy.id must be '${expectedPolicy}'`);
    assertObject(body.policy.gates, `${path}.policy.gates`);
    assert(Array.isArray(body.policy.overrides), `${path}.policy.overrides must be an array`);
    assert(typeof body.policyVersion === 'string', `${path}.policyVersion must be a string`);
    assert(typeof body.scoringVersion === 'string', `${path}.scoringVersion must be a string`);
    assertObject(body.sources, `${path}.sources`);
    for (const source of ['provider', 'db', 'registry']) {
        assert(typeof body.sources[source] === 'string', `${path}.sources.${source} must be a string`);
    }
}

/** `/v2/search` is the public judged search — the endpoint that shipped behind the Clerk allowlist. */
async function verifySearch(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/search?q=USDC&limit=5');
    assertObject(body, 'search response');
    assertJudgedEnvelope(body, 'search', 'default');
    assert(Array.isArray(body.results), 'search.results must be an array');
    assert(body.results.length > 0, 'search.results must be non-empty for q=USDC');
    assert(body.results.length <= 5, 'search.results must honour limit=5');
    const mints = body.results.map((token, i) => assertJudgedToken(token, `search.results[${i}]`));
    assert(mints.includes(USDC_MINT), 'search for USDC must rank the canonical USDC mint');
    assert(Array.isArray(body.suppressed), 'search.suppressed must be present by default');

    const trimmed = await getJson(baseUrl, apiKey, 'api/v2/search?q=USDC&limit=5&includeSuppressed=false');
    assertObject(trimmed, 'search(includeSuppressed=false)');
    assert(!('suppressed' in trimmed), 'includeSuppressed=false must omit suppressed[]');

    const res = await fetch(new URL('api/v2/search?q=USDC&policy=nope', baseUrl), {
        headers: { 'x-api-key': apiKey },
    });
    assert(res.status === 400, `invalid policy must 400, got ${res.status}`);
}

/** The documented public path is a rewrite onto `/api/v2/*`; a 404 here means the rewrite is missing. */
async function verifyPublicPathRewrite(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'v2/search?q=USDC&limit=1');
    assertObject(body, 'public-path search response');
    assert(
        Array.isArray(body.results) && body.results.length === 1,
        '/v2/search must serve the same handler as /api/v2/search',
    );
}

async function verifyResolve(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/resolve?q=USDC');
    assertObject(body, 'resolve response');
    assertJudgedEnvelope(body, 'resolve', 'default');
    assert(
        typeof body.status === 'string' && RESOLVE_STATUSES.has(body.status),
        `resolve.status must be resolved|ambiguous|no_confident_match, got ${String(body.status)}`,
    );
    assert(Array.isArray(body.candidates), 'resolve.candidates must be an array');
    if (body.status === 'resolved') {
        assertObject(body.best, 'resolve.best');
        assert(
            body.best.mint === USDC_MINT,
            `resolve(USDC) must resolve to the canonical mint, got ${String(body.best.mint)}`,
        );
        assert(
            typeof body.best.confidence === 'number' && body.best.confidence > 0 && body.best.confidence <= 1,
            'resolve.best.confidence must be in (0, 1]',
        );
    } else {
        assert(body.best === null, `resolve.best must be null when status is ${body.status}`);
    }

    // A pasted mint is a lookup, never fuzzy.
    const exact = await getJson(baseUrl, apiKey, `api/v2/resolve?q=${USDC_MINT}`);
    assertObject(exact, 'resolve(mint)');
    assert(exact.status === 'resolved', `resolve(<USDC mint>) must be resolved, got ${String(exact.status)}`);
    assertObject(exact.best, 'resolve(mint).best');
    assert(
        exact.best.mint === USDC_MINT && exact.best.confidence === 1,
        'mint lookup must return that mint with confidence 1',
    );
}

function assertRegistryItem(item: unknown, path: string): { mint: string; rank: number } {
    assertObject(item, path);
    assert(
        typeof item.mint === 'string' && looksLikeSolanaMintAddress(item.mint),
        `${path}.mint must be a base58 mint address`,
    );
    assert(typeof item.symbol === 'string' && item.symbol.length > 0, `${path}.symbol must be a non-empty string`);
    assertNullableString(item.name, `${path}.name`);
    assertNullableString(item.logoURI, `${path}.logoURI`);
    assert(typeof item.hasTokenPage === 'boolean', `${path}.hasTokenPage must be a boolean`);
    assertNullableString(item.assetId, `${path}.assetId`);
    assert(
        (item.assetId !== null) === item.hasTokenPage,
        `${path}.assetId must be set exactly when hasTokenPage is true`,
    );
    for (const key of ['group', 'category', 'assetClass', 'alliumClass', 'rwaClass']) {
        assertNullableString(item[key], `${path}.${key}`);
    }
    for (const key of ['alliumValueUsd', 'rwaValueUsd', 'marketCapUsd']) {
        assert(item[key] === null || typeof item[key] === 'number', `${path}.${key} must be a number or null`);
    }
    assert(
        typeof item.rank === 'number' && Number.isInteger(item.rank) && item.rank >= 0,
        `${path}.rank must be a non-negative integer`,
    );
    return { mint: item.mint, rank: item.rank };
}

/** `/v2/registry` is the DB-backed Project Canon asset registry (synced hourly from data.solana.com). */
async function verifyRegistry(baseUrl: string, apiKey: string): Promise<void> {
    const body = await getJson(baseUrl, apiKey, 'api/v2/registry?limit=5');
    assertObject(body, 'registry response');
    assertNullableString(body.generatedAt, 'registry.generatedAt');
    assert(body.syncedAt === null || typeof body.syncedAt === 'number', 'registry.syncedAt must be a number or null');
    assert(typeof body.total === 'number', 'registry.total must be a number');
    assert(Array.isArray(body.items), 'registry.items must be an array');
    assert(body.items.length <= 5, 'registry.items must honour limit=5');
    if (body.total === 0) {
        console.warn('registry: no rows synced yet (total=0); skipping content checks');
        return;
    }
    assert(body.items.length > 0, 'registry.items must be non-empty when total > 0');
    const items = body.items.map((item, i) => assertRegistryItem(item, `registry.items[${i}]`));
    assert(items[0]!.rank === 0, 'first page must start at rank 0 (upstream order)');
    for (let i = 1; i < items.length; i++) {
        assert(items[i]!.rank > items[i - 1]!.rank, 'registry.items must be in ascending rank order');
    }
    assert(
        items.some(item => item.mint === USDC_MINT),
        'the first five registry rows must include USDC',
    );

    const page2 = await getJson(baseUrl, apiKey, 'api/v2/registry?limit=5&offset=5');
    assertObject(page2, 'registry(offset=5)');
    assert(page2.total === body.total, 'total must be stable across pages');
    assert(Array.isArray(page2.items) && page2.items.length > 0, 'offset=5 must return rows');
    assertRegistryItem(page2.items[0], 'registry(offset=5).items[0]');
    assert((page2.items[0] as { rank: number }).rank === 5, 'offset=5 must start at rank 5');

    const filtered = await getJson(baseUrl, apiKey, 'api/v2/registry?group=Stablecoins&limit=2');
    assertObject(filtered, 'registry(group=Stablecoins)');
    assert(typeof filtered.total === 'number' && filtered.total < body.total, 'group filter must narrow total');
    assert(Array.isArray(filtered.items), 'filtered items must be an array');
    for (const [i, item] of filtered.items.entries()) {
        assertObject(item, `registry(group).items[${i}]`);
        assert(item.group === 'Stablecoins', 'every filtered row must match the group');
    }

    const res = await fetch(new URL('api/v2/registry?limit=abc', baseUrl), { headers: { 'x-api-key': apiKey } });
    assert(res.status === 400, `non-numeric limit must 400, got ${res.status}`);

    // Detail: same item shape plus the upstream row verbatim.
    const detail = await getJson(baseUrl, apiKey, `api/v2/registry/${USDC_MINT}`);
    assertObject(detail, 'registry detail');
    const detailItem = assertRegistryItem(detail, 'registry detail');
    assert(detailItem.mint === USDC_MINT, 'detail.mint must echo the path mint');
    assertObject(detail.upstream, 'registry detail.upstream');
    assert(detail.upstream.mint_address === USDC_MINT, 'detail.upstream.mint_address must be the raw upstream mint');
    assert(typeof detail.upstream.token === 'string', 'detail.upstream.token must be the raw upstream symbol');
    assertNullableString(detail.generatedAt, 'registry detail.generatedAt');
    assert(detail.syncedAt === null || typeof detail.syncedAt === 'number', 'detail.syncedAt must be a number or null');
    assertObject(detail.provider, 'registry detail.provider');

    const missing = await fetch(new URL('api/v2/registry/11111111111111111111111111111111', baseUrl), {
        headers: { 'x-api-key': apiKey },
    });
    assert(missing.status === 404, `unknown mint must 404, got ${missing.status}`);
    const malformed = await fetch(new URL('api/v2/registry/not-a-mint', baseUrl), { headers: { 'x-api-key': apiKey } });
    assert(malformed.status === 400, `malformed mint must 400, got ${malformed.status}`);
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
    await verifySearch(baseUrl, apiKey);
    await verifyResolve(baseUrl, apiKey);
    await verifyRegistry(baseUrl, apiKey);
    await verifyPublicPathRewrite(baseUrl, apiKey);

    console.log('Lists + search + registry API v2 contract verification passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
