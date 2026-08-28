// DEPRECATED: curated list membership now lives in the database
// (asset_collections, edited via the admin app), and the mint arrays moved to
// packages/asset-registry/src/data/list-mints.ts (a different format this
// script's line parser does not understand). Running it would corrupt that
// file. It is scheduled for deletion with the DB cutover.
console.error(
    '[deprecated] annotate-curated-token-lists.mjs: curated membership is DB-backed now; edit lists via the admin app. ' +
        'Mint arrays live in packages/asset-registry/src/data/list-mints.ts.',
);
process.exit(1);

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function getFlag(name) {
    return process.argv.includes(`--${name}`);
}

function getArg(name, fallback) {
    const flag = `--${name}`;
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
    return fallback;
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function isOndoMintAddress(address) {
    return typeof address === 'string' && address.trim().toLowerCase().endsWith('ondo');
}

function cleanDisplayName(rawName) {
    const name = typeof rawName === 'string' ? rawName : '';
    if (!name.trim()) return 'Unknown';

    return (
        name
            // xStocks
            .replace(/\s*xStock\s*$/i, '')
            // Bridge/origin markers in parens
            .replace(/\s*\(\s*(wormhole|bridged|wrapped|omnibridge|coinbase|ondo\s+tokenized)\s*\)\s*/gi, ' ')
            // Wrapped variants
            .replace(/^\s*coinbase\s+wrapped\s+/i, '')
            .replace(/^\s*wrapped\s+/i, '')
            .replace(/\s+wrapped\s+/gi, ' ')
            .replace(/\s+wrapped\s*$/i, '')
            // Normalize whitespace
            .replace(/\s{2,}/g, ' ')
            .trim() || 'Unknown'
    );
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

function parseDotEnv(contents) {
    const env = {};

    for (const rawLine of contents.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;

        const idx = line.indexOf('=');
        if (idx === -1) continue;

        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();

        // Strip optional surrounding quotes.
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        if (key) env[key] = value;
    }

    return env;
}

async function loadEnvFile(filePath) {
    try {
        const contents = await fs.readFile(filePath, 'utf8');
        return parseDotEnv(contents);
    } catch {
        return {};
    }
}

async function getBirdeyeApiKey(repoRoot) {
    if (process.env.BIRDEYE_API_KEY) return process.env.BIRDEYE_API_KEY;

    const argKey = getArg('api-key', null);
    if (typeof argKey === 'string' && argKey.trim()) return argKey.trim();

    const explicitEnvFile = getArg('env-file', null);
    const candidateEnvFiles = [
        ...(explicitEnvFile ? [explicitEnvFile] : []),
        path.join(repoRoot, 'apps/web/.env.local'),
        path.join(repoRoot, '.env.local'),
        path.join(repoRoot, 'apps/web/.env'),
        path.join(repoRoot, '.env'),
    ];

    for (const envFile of candidateEnvFiles) {
        const env = await loadEnvFile(envFile);
        const key = env.BIRDEYE_API_KEY;
        if (typeof key === 'string' && key.trim()) return key.trim();
    }

    throw new Error(
        [
            'Missing BIRDEYE_API_KEY.',
            'Provide it via:',
            '- env var: BIRDEYE_API_KEY=...',
            '- CLI arg: --api-key ...',
            '- env file: --env-file apps/web/.env.local',
        ].join('\n'),
    );
}

async function fetchWithRetry(url, options, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const res = await fetch(url, options);

        if (res.ok) return res;

        if (res.status === 429) {
            const waitMs = Math.pow(2, attempt) * 1000;
            await sleep(waitMs);
            lastError = new Error(`Birdeye rate limit: ${res.status} ${res.statusText}`);
            continue;
        }

        const bodyText = await res.text().catch(() => '');
        throw new Error(`Birdeye API error: ${res.status} ${res.statusText}${bodyText ? `\n${bodyText}` : ''}`);
    }

    throw lastError ?? new Error('Birdeye max retries exceeded');
}

async function getTokenLabelFromBirdeye(address, apiKey) {
    const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(address)}`;
    const res = await fetchWithRetry(
        url,
        {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
        },
        4,
    );

    const json = await res.json().catch(() => null);
    const data = json?.data;
    if (!json?.success || !data) return null;

    const symbolRaw = typeof data.symbol === 'string' ? data.symbol.trim() : '';
    const nameRaw = typeof data.name === 'string' ? data.name.trim() : '';

    if (symbolRaw && nameRaw && symbolRaw.toLowerCase() !== nameRaw.toLowerCase()) return `${symbolRaw} (${nameRaw})`;
    if (symbolRaw) return symbolRaw;
    if (nameRaw) return nameRaw;
    return null;
}

async function getTokenLabelFromBirdeyeSearch(address, apiKey) {
    const params = new URLSearchParams({
        keyword: address,
        chain: 'solana',
        target: 'token',
        offset: '0',
        limit: '10',
        sort_by: 'volume_24h_usd',
        sort_type: 'desc',
    });

    const url = `https://public-api.birdeye.so/defi/v3/search?${params}`;
    const res = await fetchWithRetry(
        url,
        {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
        },
        4,
    );

    const json = await res.json().catch(() => null);
    const items = json?.data?.items;
    if (!json?.success || !Array.isArray(items)) return null;

    const tokenSection = items.find(i => i && typeof i === 'object' && i.type === 'token');
    const results = Array.isArray(tokenSection?.result) ? tokenSection.result : [];
    if (results.length === 0) return null;

    const exact = results.find(r => r?.address === address);
    const candidate = exact ?? results[0];

    const symbolRaw = typeof candidate?.symbol === 'string' ? candidate.symbol.trim() : '';
    const nameRaw = typeof candidate?.name === 'string' ? candidate.name.trim() : '';

    if (symbolRaw && nameRaw && symbolRaw.toLowerCase() !== nameRaw.toLowerCase()) return `${symbolRaw} (${nameRaw})`;
    if (symbolRaw) return symbolRaw;
    if (nameRaw) return nameRaw;
    return null;
}

async function getTokenNameFromBirdeye(address, apiKey) {
    const url = `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(address)}`;
    const res = await fetchWithRetry(
        url,
        {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
        },
        4,
    );

    const json = await res.json().catch(() => null);
    const data = json?.data;
    if (!json?.success || !data) return null;

    const nameRaw = typeof data.name === 'string' ? data.name.trim() : '';
    return nameRaw || null;
}

async function getTokenNameFromBirdeyeSearch(address, apiKey) {
    const params = new URLSearchParams({
        keyword: address,
        chain: 'solana',
        target: 'token',
        offset: '0',
        limit: '10',
        sort_by: 'volume_24h_usd',
        sort_type: 'desc',
    });

    const url = `https://public-api.birdeye.so/defi/v3/search?${params}`;
    const res = await fetchWithRetry(
        url,
        {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                Accept: 'application/json',
            },
        },
        4,
    );

    const json = await res.json().catch(() => null);
    const items = json?.data?.items;
    if (!json?.success || !Array.isArray(items)) return null;

    const tokenSection = items.find(i => i && typeof i === 'object' && i.type === 'token');
    const results = Array.isArray(tokenSection?.result) ? tokenSection.result : [];
    if (results.length === 0) return null;

    const exact = results.find(r => r?.address === address);
    const candidate = exact ?? results[0];

    const nameRaw = typeof candidate?.name === 'string' ? candidate.name.trim() : '';
    return nameRaw || null;
}

async function getBestTokenName(address, apiKey) {
    try {
        const name = await getTokenNameFromBirdeye(address, apiKey);
        if (name) return name;
    } catch {
        // fall through to search
    }

    try {
        return await getTokenNameFromBirdeyeSearch(address, apiKey);
    } catch {
        return null;
    }
}

async function getBestTokenLabel(address, apiKey) {
    try {
        const label = await getTokenLabelFromBirdeye(address, apiKey);
        if (label) return label;
    } catch {
        // fall through to search
    }

    try {
        return await getTokenLabelFromBirdeyeSearch(address, apiKey);
    } catch {
        return null;
    }
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const idx = nextIndex;
            if (idx >= items.length) return;
            nextIndex += 1;
            results[idx] = await mapper(items[idx], idx);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function getAddressLineData(line) {
    // Matches lines like:
    //   'So111...', // SOL
    //   'So111...',
    const match = line.match(/^(\s*)'([^']+)',\s*(\/\/\s*(.*))?\s*$/);
    if (!match) return null;

    const indent = match[1] ?? '';
    const address = match[2] ?? '';
    const comment = (match[4] ?? '').trim();

    return {
        indent,
        address,
        comment,
        hasComment: Boolean(comment),
    };
}

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '..');

    const curatedFilePath = path.join(repoRoot, 'packages/asset-registry/src/data/curated-token-lists.ts');

    const write = getFlag('write');
    const updateUnknown = getFlag('update-unknown');
    const ondoOnly = getFlag('ondo-only');
    const onlyListId = getArg('list-id', null);
    const concurrency = Math.max(1, toInt(getArg('concurrency', '2'), 2));
    const delayMs = Math.max(0, toInt(getArg('delay-ms', '200'), 200));

    const fileContents = await fs.readFile(curatedFilePath, 'utf8');
    const lines = fileContents.split('\n');

    const existingLabelByAddress = new Map();
    const missing = [];

    let inAddresses = false;
    /** @type {string | null} */
    let currentListId = null;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (!inAddresses) {
            const listKeyMatch = line.match(/^\s{4}([a-zA-Z0-9_]+):\s*{\s*$/);
            if (listKeyMatch) currentListId = listKeyMatch[1];
        }

        if (!inAddresses && line.includes('addresses: [')) {
            inAddresses = true;
            continue;
        }

        if (inAddresses && line.trimStart().startsWith('],')) {
            inAddresses = false;
            continue;
        }

        if (!inAddresses) continue;
        if (typeof onlyListId === 'string' && onlyListId.trim() && currentListId !== onlyListId.trim()) continue;

        const data = getAddressLineData(line);
        if (!data) continue;

        if (ondoOnly && !isOndoMintAddress(data.address)) {
            // Respect scope: leave non-Ondo addresses untouched.
            continue;
        }

        if (data.hasComment) {
            const isUnknown = data.comment.trim().toLowerCase() === 'unknown';

            if (isUnknown && updateUnknown) {
                missing.push({ lineIndex: i, indent: data.indent, address: data.address });
                continue;
            }

            if (!existingLabelByAddress.has(data.address)) existingLabelByAddress.set(data.address, data.comment);
            continue;
        }

        missing.push({ lineIndex: i, indent: data.indent, address: data.address });
    }

    if (missing.length === 0) {
        console.log('No missing inline token comments found.');
        return;
    }

    const apiKey = await getBirdeyeApiKey(repoRoot);
    const uniqueMissingAddresses = Array.from(new Set(missing.map(x => x.address)));

    console.log(
        [
            'Annotating curated token lists',
            `missing=${missing.length}`,
            `uniqueMissing=${uniqueMissingAddresses.length}`,
            `concurrency=${concurrency}`,
            `delayMs=${delayMs}`,
            `write=${write}`,
            `updateUnknown=${updateUnknown}`,
            `ondoOnly=${ondoOnly}`,
            `listId=${onlyListId ?? 'all'}`,
        ].join(' | '),
    );

    const labelCache = new Map(existingLabelByAddress);

    await mapWithConcurrency(uniqueMissingAddresses, concurrency, async (address, idx) => {
        if (labelCache.has(address)) return;

        // Space requests out a bit to avoid rate limits.
        if (idx > 0) await sleep(delayMs);

        try {
            if (ondoOnly || isOndoMintAddress(address)) {
                const rawName = await getBestTokenName(address, apiKey);
                const cleaned = cleanDisplayName(rawName);
                if (cleaned && cleaned.toLowerCase() !== 'unknown') labelCache.set(address, cleaned);
                return;
            }

            const label = await getBestTokenLabel(address, apiKey);
            if (label) labelCache.set(address, label);
        } catch (error) {
            console.warn(`Birdeye lookup failed for ${address}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    let changed = 0;
    let unresolved = 0;

    for (const item of missing) {
        const label = labelCache.get(item.address);
        if (!label) {
            unresolved += 1;
            continue;
        }

        lines[item.lineIndex] = `${item.indent}'${item.address}', // ${label}`;
        changed += 1;
    }

    console.log(`resolved=${changed}/${missing.length} missing comments`);
    if (unresolved > 0) console.log(`unresolved=${unresolved} (Birdeye did not return metadata)`);

    if (!write) {
        console.log('Dry run. Re-run with --write to update the file.');
        return;
    }

    await fs.writeFile(curatedFilePath, lines.join('\n'));
    console.log(`Updated ${path.relative(repoRoot, curatedFilePath)}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
