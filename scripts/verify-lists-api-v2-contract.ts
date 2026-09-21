/* eslint-disable no-console */

/**
 * Live contract check for the v2 API: lists ("lists as plugins") plus the
 * public judged search (`/v2/search`, `/v2/resolve`).
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
        assert(body.best.mint === USDC_MINT, `resolve(USDC) must resolve to the canonical mint, got ${String(body.best.mint)}`);
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
    assert(exact.best.mint === USDC_MINT && exact.best.confidence === 1, 'mint lookup must return that mint with confidence 1');
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

    console.log('Lists + search API v2 contract verification passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
