/* eslint-disable no-console */

/**
 * Live contract check for the v2 execution API.
 *
 * Usage:
 *   API_BASE_URL=http://localhost:3002 API_KEY=... bun scripts/verify-execution-api-v2-contract.ts
 *
 * Exercises GET /v2/execution/links and GET /v2/execution/evaluate
 * (execution:read).
 *
 * Asserts shape and invariants only — never that a particular provider won or
 * that any given size was routable. A router being down must not fail the
 * contract check, but the structural guarantees must hold regardless.
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
    // Read the body only on failure: assert's message argument is evaluated
    // eagerly, so reading it up front would consume the stream before json().
    if (!res.ok) {
        const detail = await res.text().then(text => text.slice(0, 300));
        throw new Error(`GET ${path} failed: HTTP ${res.status} ${detail}`);
    }
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

    // 6. Evaluate: the default ladder answers with no amounts named.
    const defaulted = await getJson(baseUrl, apiKey, `api/v2/execution/evaluate?mint=${CBBTC_MINT}`);
    const defaultedResult = assertQuotesResponse(defaulted, 'evaluate(default)');
    assertObject(defaulted, 'evaluate(default)');
    assertObject(defaulted.meta, 'evaluate(default).meta');
    assert(defaulted.meta.amountSource === 'default', 'a call with no amounts must report amountSource=default');
    assert(Array.isArray(defaulted.meta.defaultLadderUsd), 'defaultLadderUsd must be listed when defaulted');
    assert(
        defaultedResult.entryCount === (defaulted.meta.defaultLadderUsd as unknown[]).length,
        'the default ladder must produce one entry per rung',
    );
    console.log(`evaluate(default): ${defaultedResult.entryCount} rungs, ${defaultedResult.available} available`);

    // 7. Evaluate: explicit sizes, ascending.
    const sized = await getJson(
        baseUrl,
        apiKey,
        // The repeated $10k rung must be deduped, not quoted twice.
        `api/v2/execution/evaluate?mint=${CBBTC_MINT}&amountUsd=10000&amountUsd=1000000&amountUsd=10000`,
    );
    assertQuotesResponse(sized, 'evaluate(sized)');
    assertObject(sized, 'evaluate(sized)');
    assertObject(sized.meta, 'evaluate(sized).meta');
    assert(sized.meta.deduped === 1, `one repeated amount must report meta.deduped=1, got ${sized.meta.deduped}`);
    assert(sized.meta.amountSource === 'request', 'explicit amounts must report amountSource=request');
    assert(sized.meta.requested === 2, 'two amounts must produce two entries');
    console.log('evaluate(sized): explicit ladder honored');

    // 8. Evaluate: a single provider has nothing to compare against.
    const single = await getJson(
        baseUrl,
        apiKey,
        `api/v2/execution/evaluate?mint=${CBBTC_MINT}&amountUsd=10000&providers=jupiter`,
    );
    assertQuotesResponse(single, 'evaluate(single provider)');
    assertObject(single, 'evaluate(single provider)');
    assert(Array.isArray(single.providers) && single.providers.length === 1, 'providers filter must narrow the set');
    for (const [index, entry] of (single.quotes as Record<string, unknown>[]).entries()) {
        assert(entry.edge === null, `evaluate(single provider).quotes[${index}].edge must be null`);
    }
    assertObject(single.meta, 'evaluate(single provider).meta');
    assertObject((single.meta as Record<string, unknown>).summary, 'evaluate(single provider).meta.summary');
    console.log('evaluate(single provider): no edge, as expected');

    // 9. Evaluate errors.
    const missingMint = await getRaw(baseUrl, apiKey, 'api/v2/execution/evaluate');
    assert(missingMint.status === 400, `missing mint must 400, got ${missingMint.status}`);
    const badMint = await getRaw(baseUrl, apiKey, 'api/v2/execution/evaluate?mint=not-a-mint');
    assert(badMint.status === 400, `invalid mint must 400, got ${badMint.status}`);
    const wrongSide = await getRaw(baseUrl, apiKey, `api/v2/execution/evaluate?mint=${CBBTC_MINT}&tokenAmount=1`);
    assert(wrongSide.status === 400, `tokenAmount on a buy must 400, got ${wrongSide.status}`);
    const tooSmall = await getRaw(baseUrl, apiKey, `api/v2/execution/evaluate?mint=${CBBTC_MINT}&amountUsd=0.5`);
    assert(tooSmall.status === 400, `a sub-dollar buy must 400, got ${tooSmall.status}`);
    const tooBig = await getRaw(baseUrl, apiKey, `api/v2/execution/evaluate?mint=${CBBTC_MINT}&amountUsd=50000001`);
    assert(tooBig.status === 400, `an over-cap buy must 400, got ${tooBig.status}`);
    // Ten *distinct* amounts: the cap applies to unique amounts, so repeating
    // one value would collapse to a single rung and legitimately succeed.
    const distinctAmounts = Array.from({ length: 10 }, (_, index) => `&amountUsd=${10_000 + index}`).join('');
    const tooMany = await getRaw(baseUrl, apiKey, `api/v2/execution/evaluate?mint=${CBBTC_MINT}${distinctAmounts}`);
    assert(tooMany.status === 400, `more than nine amounts must 400 (never truncate), got ${tooMany.status}`);
    const badProvider = await getRaw(
        baseUrl,
        apiKey,
        `api/v2/execution/evaluate?mint=${CBBTC_MINT}&amountUsd=10000&providers=uniswap`,
    );
    assert(badProvider.status === 400, `an unknown provider must 400, got ${badProvider.status}`);
    const badProviderBody = (await badProvider.json()) as { error?: { _tag?: string } };
    assert(
        badProviderBody.error?._tag === 'BadRequestError',
        'an unknown provider must return the BadRequestError envelope',
    );
    console.log('evaluate(errors): 400 envelopes verified');

    // 10. Route: cross-variant comparison over a canonical asset.
    const routed = await getJson(baseUrl, apiKey, 'api/v2/execution/route?assetId=bitcoin&amountUsd=1000000');
    assertObject(routed, 'route(bitcoin)');
    assert(routed.assetId === 'bitcoin', 'route must echo the canonical assetId');
    assert(Array.isArray(routed.variants) && routed.variants.length >= 1, 'route must select at least one variant');
    assertObject(routed.meta, 'route(bitcoin).meta');
    const routeMeta = routed.meta as Record<string, unknown>;
    assert(Array.isArray(routeMeta.probeLadderUsd), 'route meta must list the probe ladder');
    const ladder = routeMeta.probeLadderUsd as number[];
    assert(
        ladder[ladder.length - 1] === 1_000_000,
        'the probe ladder must include the target itself as its top rung',
    );
    const routeRanks: number[] = [];
    for (const [index, rawVariant] of (routed.variants as unknown[]).entries()) {
        const path = `route(bitcoin).variants[${index}]`;
        assertObject(rawVariant, path);
        const variant = rawVariant as Record<string, unknown>;
        assert(typeof variant.mint === 'string', `${path}.mint must be a string`);
        assert(typeof variant.rank === 'number', `${path}.rank must be a number`);
        routeRanks.push(variant.rank as number);
        assert(
            variant.parityBasis === 'kind',
            `${path}.parityBasis must be 'kind' for bitcoin (wrapped/bridged variants)`,
        );
        // Every selected variant carries one row per probe rung, using the
        // exact evaluate row shape (re-assert the core invariants per row).
        assert(Array.isArray(variant.quotes), `${path}.quotes must be an array`);
        assert(
            (variant.quotes as unknown[]).length === ladder.length,
            `${path} must carry one quote row per probe rung`,
        );
        assertObject(variant.curve, `${path}.curve`);
        const curve = variant.curve as Record<string, unknown>;
        assert(Array.isArray(curve.rungs) && (curve.rungs as unknown[]).length === ladder.length,
            `${path}.curve must have one rung per probe size`);
    }
    assert(
        routeRanks.every((rank, index) => rank === index + 1),
        'route variants must be in gapless 1..n rank order',
    );
    const excluded = routeMeta.excludedVariants as Record<string, unknown>[];
    assert(Array.isArray(excluded), 'route meta must list excluded variants');
    for (const entry of excluded) {
        assert(typeof entry.reason === 'string' && entry.reason.length > 0, 'excluded variants must carry reasons');
    }
    assert(
        routeMeta.upstreamQuotes ===
            (routed.variants as unknown[]).length * ladder.length * (routed.providers as unknown[]).length,
        'route upstreamQuotes must equal variants x rungs x providers before verification quotes',
    );
    console.log(
        `route(bitcoin): ${(routed.variants as unknown[]).length} variants x ${ladder.length} rungs, ` +
            `${excluded.length} excluded, status=${routed.allocationStatus}`,
    );

    // 11. Route errors.
    const unknownRouteAsset = await getRaw(baseUrl, apiKey, 'api/v2/execution/route?assetId=not-an-asset');
    assert(unknownRouteAsset.status === 404, `unknown assetId must 404, got ${unknownRouteAsset.status}`);
    const sellSide = await getRaw(baseUrl, apiKey, 'api/v2/execution/route?assetId=bitcoin&side=sell');
    assert(sellSide.status === 400, `side=sell must 400, got ${sellSide.status}`);
    const badMax = await getRaw(baseUrl, apiKey, 'api/v2/execution/route?assetId=bitcoin&maxVariants=7');
    assert(badMax.status === 400, `maxVariants above the cap must 400, got ${badMax.status}`);
    console.log('route(errors): 400/404 envelopes verified');

    console.log('v2 execution API contract OK');
}

function assertProviderQuote(value: unknown, path: string): { provider: string; rank: number | null; isBest: boolean; outRaw: bigint | null } {
    assertObject(value, path);
    assert(typeof value.provider === 'string' && value.provider.length > 0, `${path}.provider must be a string`);
    assert(
        value.status === 'available' || value.status === 'unavailable',
        `${path}.status must be available or unavailable`,
    );
    assert(typeof value.isBest === 'boolean', `${path}.isBest must be a boolean`);
    assert(
        value.priceImpactSource === 'provider' || value.priceImpactSource === 'unavailable',
        `${path}.priceImpactSource must be provider or unavailable`,
    );
    // Impact honesty, asserted without naming any provider: a reported source
    // implies a number, and an unavailable source implies none.
    if (value.priceImpactSource === 'provider') {
        assert(typeof value.priceImpactPct === 'number', `${path}.priceImpactPct must be set when source=provider`);
    } else {
        assert(value.priceImpactPct === null, `${path}.priceImpactPct must be null when source=unavailable`);
    }

    if (value.status === 'unavailable') {
        assert(value.rank === null, `${path}.rank must be null when unavailable`);
        assert(value.isBest === false, `${path}.isBest must be false when unavailable`);
        assert(value.input === null && value.output === null, `${path} must carry no amounts when unavailable`);
        assert(typeof value.reason === 'string', `${path}.reason must be set when unavailable`);
        return { provider: value.provider, rank: null, isBest: false, outRaw: null };
    }

    assert(typeof value.rank === 'number' && value.rank >= 1, `${path}.rank must be a positive integer`);
    assertObject(value.output, `${path}.output`);
    const outRaw = value.output.rawAmount;
    assert(typeof outRaw === 'string' && /^\d+$/.test(outRaw), `${path}.output.rawAmount must be an integer string`);
    assertObject(value.input, `${path}.input`);
    assert(Array.isArray(value.route), `${path}.route must be an array`);
    return { provider: value.provider, rank: value.rank, isBest: value.isBest, outRaw: BigInt(outRaw) };
}

function assertQuotesResponse(body: unknown, label: string): { entryCount: number; available: number } {
    assertObject(body, label);
    assert(typeof body.mint === 'string' && body.mint.length > 0, `${label}.mint must be a string`);
    assert(body.side === 'buy' || body.side === 'sell', `${label}.side must be buy or sell`);
    assert(Array.isArray(body.providers) && body.providers.length > 0, `${label}.providers must be a non-empty array`);
    assertObject(body.token, `${label}.token`);
    assert(Number.isInteger(body.token.decimals), `${label}.token.decimals must be an integer`);
    assert(Array.isArray(body.quotes), `${label}.quotes must be an array`);

    let available = 0;
    let previousRaw: bigint | null = null;
    (body.quotes as unknown[]).forEach((raw, index) => {
        const path = `${label}.quotes[${index}]`;
        assertObject(raw, path);
        assertObject(raw.request, `${path}.request`);
        const rawAmount = (raw.request as Record<string, unknown>).rawAmount;
        assert(typeof rawAmount === 'string' && /^\d+$/.test(rawAmount), `${path}.request.rawAmount must be integral`);
        // Ladder order is part of the contract: rungs ascend.
        const current = BigInt(rawAmount);
        if (previousRaw !== null) assert(current > previousRaw, `${path}.request.rawAmount must ascend`);
        previousRaw = current;

        assert(Array.isArray(raw.providerQuotes), `${path}.providerQuotes must be an array`);
        assert(
            (raw.providerQuotes as unknown[]).length === (body.providers as unknown[]).length,
            `${path}.providerQuotes must cover every queried provider`,
        );
        const quotes = (raw.providerQuotes as unknown[]).map((quote, quoteIndex) =>
            assertProviderQuote(quote, `${path}.providerQuotes[${quoteIndex}]`),
        );

        const bests = quotes.filter(quote => quote.isBest);
        const availableQuotes = quotes.filter(quote => quote.outRaw !== null);

        // Ranked best-first, with gapless 1..n ranks over available quotes.
        const ranks = availableQuotes.map(quote => quote.rank!).sort((a, b) => a - b);
        ranks.forEach((rank, rankIndex) => {
            assert(rank === rankIndex + 1, `${path} ranks must be 1..n with no gaps`);
        });
        for (let i = 1; i < availableQuotes.length; i += 1) {
            const previous = quotes.findIndex(quote => quote.rank === i);
            const next = quotes.findIndex(quote => quote.rank === i + 1);
            if (previous >= 0 && next >= 0) {
                assert(
                    quotes[previous]!.outRaw! >= quotes[next]!.outRaw!,
                    `${path}.providerQuotes must be ordered by descending output`,
                );
            }
        }

        if (raw.status === 'available') {
            available += 1;
            assert(bests.length === 1, `${path} must have exactly one isBest quote when available`);
            assertObject(raw.best, `${path}.best`);
            // The hoisted winner must be the same quote, not a divergent copy.
            assert(
                (raw.best as Record<string, unknown>).provider === bests[0]!.provider,
                `${path}.best must be the providerQuotes entry flagged isBest`,
            );
            assert(
                (raw.best as Record<string, unknown>).status === 'available',
                `${path}.best must itself be an available quote`,
            );
        } else {
            assert(bests.length === 0, `${path} must have no isBest quote when unavailable`);
            assert(raw.best === null, `${path}.best must be null when unavailable`);
            assert(raw.edge === null, `${path}.edge must be null when unavailable`);
            assert(typeof raw.reason === 'string', `${path}.reason must be set when unavailable`);
        }

        // Edge exists only where at least two providers actually quoted.
        if (availableQuotes.length < 2) {
            assert(raw.edge === null, `${path}.edge must be null when fewer than two providers quoted`);
        } else if (raw.edge !== null) {
            assertObject(raw.edge, `${path}.edge`);
            const edge = raw.edge as Record<string, unknown>;
            assert(typeof edge.bps === 'number' && edge.bps >= 0, `${path}.edge.bps must be >= 0`);
            assert(
                edge.runnerUp !== (raw.best as Record<string, unknown>).provider,
                `${path}.edge.runnerUp must differ from the winner`,
            );
            const diff = edge.outAmountDiffRaw;
            assert(typeof diff === 'string' && /^\d+$/.test(diff), `${path}.edge.outAmountDiffRaw must be integral`);
            const sorted = [...availableQuotes].sort((a, b) => (b.outRaw! > a.outRaw! ? 1 : -1));
            assert(
                BigInt(diff) === sorted[0]!.outRaw! - sorted[1]!.outRaw!,
                `${path}.edge.outAmountDiffRaw must equal best minus runner-up`,
            );
        }
    });

    assertObject(body.meta, `${label}.meta`);
    const meta = body.meta as Record<string, unknown>;
    assert(
        meta.requested === (body.quotes as unknown[]).length,
        `${label}.meta.requested must match the entry count`,
    );
    assert(
        (meta.available as number) + (meta.unavailable as number) === meta.requested,
        `${label}.meta available + unavailable must equal requested`,
    );
    assert(typeof meta.comparisonVersion === 'string', `${label}.meta.comparisonVersion must be a string`);
    assert(typeof meta.upstreamQuotes === 'number', `${label}.meta.upstreamQuotes must be a number`);
    assertObject(meta.limits, `${label}.meta.limits`);
    assertObject(meta.providerStats, `${label}.meta.providerStats`);
    for (const [provider, statRaw] of Object.entries(meta.providerStats as Record<string, unknown>)) {
        const statPath = `${label}.meta.providerStats.${provider}`;
        assertObject(statRaw, statPath);
        const stat = statRaw as Record<string, number>;
        assert(
            stat.wins + stat.soleQuotes <= stat.quoted,
            `${statPath}: wins + soleQuotes cannot exceed quoted`,
        );
    }
    assertObject(meta.summary, `${label}.meta.summary`);
    const summary = meta.summary as Record<string, unknown>;
    assert(
        (summary.comparableEntries as number) <= (meta.requested as number),
        `${label}.meta.summary.comparableEntries cannot exceed requested`,
    );
    if (summary.bestProvider !== null) {
        assert(
            (body.providers as string[]).includes(summary.bestProvider as string),
            `${label}.meta.summary.bestProvider must be one of the queried providers`,
        );
    }

    return { entryCount: (body.quotes as unknown[]).length, available };
}

main().catch(error => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
});
