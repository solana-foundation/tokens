import { loadLocalEnv } from './_env.mjs';
import { callCloudRun, cloudRunEnabled } from './_cloudrun.mjs';

function getArg(name, fallback = null) {
    const flag = `--${name}`;
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return fallback;
}

function toBool(value, fallback) {
    if (value == null) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value) {
    return String(value)
        .normalize('NFKD')
        .replace(/['"]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function normalizeText(value) {
    return String(value ?? '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // `&amp;` last so `&amp;nbsp;` decodes to the literal `&nbsp;` instead of a space.
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeComparable(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isGenericXstocksBoilerplate(value) {
    const normalized = normalizeText(value).toLowerCase();
    return (
        normalized.includes('for too long, investing has come with barriers') &&
        normalized.includes('xstocks were created to change that')
    );
}

function buildCmcUrlCandidates(asset) {
    const slugs = new Set(
        [asset.name, asset.assetId, asset.symbol]
            .map(value => slugify(value ?? ''))
            .filter(Boolean),
    );

    const candidates = [];
    for (const slug of slugs) {
        candidates.push(`https://coinmarketcap.com/currencies/${slug}-tokenized-stock-xstock/`);
        candidates.push(`https://coinmarketcap.com/currencies/${slug}-tokenised-stock-xstock/`);
    }
    return candidates;
}

function extractCmcAbout(html, assetName) {
    const headingPattern = /About\s+.{1,140}?\s+Tokeni[sz]ed\s+Stock\s+\(xStock\)/i;
    const headingMatch = html.match(headingPattern);
    const heading = headingMatch?.[0] ?? `About ${assetName} tokenized stock (xStock)`;
    const idx = headingMatch?.index ?? html.indexOf(heading);
    if (idx === -1) return null;

    const slice = html.slice(idx, idx + 8000);
    const stopMarkers = [
        '<h3 class="faq-question" itemProp="name"',
        '<h3 class="faq-question" itemprop="name"',
        'Related CMC AI Articles',
        'Similar Coins to',
        'Popular Real World Assets',
        '<a data-read-only',
        '### Global',
        'Trending',
        'Markets',
        'Holders',
    ];

    let end = slice.length;
    for (const marker of stopMarkers) {
        const markerIdx = slice.indexOf(marker);
        if (markerIdx !== -1) end = Math.min(end, markerIdx);
    }

    let text = normalizeText(slice.slice(0, end));
    if (text.startsWith(heading)) text = text.slice(heading.length).trim();
    return text || null;
}

function hasAssetSignal(description, asset) {
    const normalized = normalizeComparable(description);
    const name = normalizeComparable(asset.name);
    const symbol = normalizeComparable(asset.symbol);
    const assetId = normalizeComparable(asset.assetId);

    const signals = [name, symbol, assetId]
        .filter(Boolean)
        .flatMap(value => {
            const parts = value.split(/\s+/).filter(part => part.length >= 4);
            return [value, ...parts];
        })
        .filter(value => value.length >= 3);

    return signals.some(signal => normalized.includes(signal));
}

function pickDescription(rawDescription, asset, options) {
    const description = normalizeText(rawDescription);
    if (!description) return null;
    if (description.length < options.minLength) return null;

    if (options.preferKeyBenefits) {
        const marker = 'Key Benefits';
        const idx = description.indexOf(marker);
        if (idx !== -1) {
            const after = normalizeText(description.slice(idx + marker.length));
            if (
                after.length >= options.minLength &&
                !isGenericXstocksBoilerplate(after) &&
                hasAssetSignal(after, asset)
            )
                return after;

            return null;
        }

        if (options.requireKeyBenefits) return null;
    }

    if (options.skipGeneric && isGenericXstocksBoilerplate(description)) return null;
    if (!hasAssetSignal(description, asset)) return null;
    return description;
}

async function fetchCmcDescription(asset) {
    let lastError = null;
    for (const url of buildCmcUrlCandidates(asset)) {
        const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
        if (!res.ok) {
            lastError = `HTTP ${res.status}`;
            if (res.status === 429) return { url, description: null, error: lastError };
            continue;
        }

        const html = await res.text();
        const description = extractCmcAbout(html, asset.name ?? asset.assetId);
        if (description) return { url, description, error: null };
        lastError = 'missing_about';
    }

    return {
        url: buildCmcUrlCandidates(asset)[0] ?? null,
        description: null,
        error: lastError ?? 'not_found',
    };
}

function isXstockAsset(asset) {
    const coinId = String(asset.coingeckoId ?? '').toLowerCase();
    if (coinId.endsWith('-xstock')) return true;
    return (asset.aliases ?? []).some(alias => String(alias).toLowerCase() === 'xstock');
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    await loadLocalEnv();

    if (!cloudRunEnabled('assets')) {
        throw new Error(
            'Cloud Run backend is not configured. Set TOKENS_CLOUDRUN_ENABLED=true (or TOKENS_CLOUDRUN_ASSETS_URL) and TOKENS_CLOUDRUN_AUTH_TOKEN. The target deployment is selected by these env vars (the old --prod/--push Convex flags are gone).',
        );
    }

    const dryRun = toBool(getArg('dry-run', 'false'), false);
    const skipGeneric = toBool(getArg('skip-generic', 'true'), true);
    const preferKeyBenefits = toBool(getArg('prefer-key-benefits', 'true'), true);
    const requireKeyBenefits = toBool(getArg('require-key-benefits', 'false'), false);
    const minLength = Math.max(toInt(getArg('min-length', '60'), 60), 1);
    const delayMs = Math.max(toInt(getArg('delay-ms', '150'), 150), 0);
    const limit = Math.min(Math.max(toInt(getArg('limit', '500'), 500), 1), 500);
    const maxConsecutiveRateLimits = Math.max(toInt(getArg('max-consecutive-429', '5'), 5), 1);
    const onlyAssets = new Set(
        String(getArg('assets', '') ?? '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),
    );

    const listed = await callCloudRun('assets', 'query', 'listByCategory', {
        category: 'equity',
        limit,
        includeInactive: false,
    });
    const assets = (Array.isArray(listed) ? listed : [])
        .filter(isXstockAsset)
        .filter(asset => onlyAssets.size === 0 || onlyAssets.has(asset.assetId));

    const stats = {
        scanned: assets.length,
        updated: 0,
        skippedGeneric: 0,
        skippedShort: 0,
        missingAbout: 0,
        fetchErrors: 0,
        unchanged: 0,
        rateLimited: false,
    };
    let consecutiveRateLimits = 0;

    for (const asset of assets) {
        const cmc = await fetchCmcDescription(asset);
        if (cmc.error) {
            if (cmc.error === 'HTTP 429') {
                consecutiveRateLimits += 1;
                if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
                    stats.rateLimited = true;
                    console.log(
                        JSON.stringify({
                            assetId: asset.assetId,
                            name: asset.name,
                            cmcUrl: cmc.url,
                            error: cmc.error,
                            stopped: `hit ${consecutiveRateLimits} consecutive rate limits`,
                        }),
                    );
                    break;
                }
            } else {
                consecutiveRateLimits = 0;
            }
            stats.fetchErrors += 1;
            console.log(JSON.stringify({ assetId: asset.assetId, name: asset.name, cmcUrl: cmc.url, error: cmc.error }));
            await sleep(delayMs);
            continue;
        }
        consecutiveRateLimits = 0;

        if (!cmc.description) {
            stats.missingAbout += 1;
            console.log(JSON.stringify({ assetId: asset.assetId, name: asset.name, cmcUrl: cmc.url, error: 'missing_about' }));
            await sleep(delayMs);
            continue;
        }

        const picked = pickDescription(cmc.description, asset, { minLength, preferKeyBenefits, requireKeyBenefits, skipGeneric });
        if (!picked) {
            if (isGenericXstocksBoilerplate(cmc.description)) stats.skippedGeneric += 1;
            else stats.skippedShort += 1;
            console.log(
                JSON.stringify({
                    assetId: asset.assetId,
                    name: asset.name,
                    cmcUrl: cmc.url,
                    skipped: isGenericXstocksBoilerplate(cmc.description) ? 'generic' : 'too_short',
                    rawLength: normalizeText(cmc.description).length,
                }),
            );
            await sleep(delayMs);
            continue;
        }

        const previous = normalizeText(asset.description);
        if (previous === picked) {
            stats.unchanged += 1;
            await sleep(delayMs);
            continue;
        }

        console.log(
            JSON.stringify({
                assetId: asset.assetId,
                name: asset.name,
                cmcUrl: cmc.url,
                dryRun,
                previousLength: previous.length,
                nextLength: picked.length,
                nextDescription: picked,
            }),
        );

        if (!dryRun) {
            await callCloudRun('assets', 'mutation', 'setAssetDescriptionByAssetId', {
                assetId: asset.assetId,
                description: picked,
            });
        }
        stats.updated += 1;
        await sleep(delayMs);
    }

    console.log(JSON.stringify(stats, null, 2));
}

await main();
