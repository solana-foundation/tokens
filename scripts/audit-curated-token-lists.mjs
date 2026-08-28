// DEPRECATED: curated list membership now lives in the database
// (asset_collections, edited via the admin app), and the mint arrays moved to
// packages/asset-registry/src/data/list-mints.ts (a different format this
// script's line parser does not understand). Running it would corrupt that
// file. It is scheduled for deletion with the DB cutover.
console.error(
    '[deprecated] audit-curated-token-lists.mjs: curated membership is DB-backed now; edit lists via the admin app. ' +
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

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(value);
}

async function sleep(ms) {
    if (ms <= 0) return;
    await new Promise(resolve => setTimeout(resolve, ms));
}

function parseDotEnv(contents) {
    /** @type {Record<string, string>} */
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
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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

function sanitizeInlineComment(value) {
    const raw = typeof value === 'string' ? value : '';
    return raw.replace(/\s+/g, ' ').trim();
}

function cleanOndoTokenName(name) {
    const raw = typeof name === 'string' ? name : '';
    return (
        raw
            .replace(/\s*\(\s*ondo\s+tokenized\s*\)\s*/gi, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
    );
}

async function fetchWithRetry(url, options, maxRetries = 4) {
    /** @type {Error | null} */
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        const res = await fetch(url, options);
        if (res.ok) return res;

        if (res.status === 429) {
            const waitMs = Math.pow(2, attempt) * 1000;
            await sleep(waitMs);
            lastError = new Error(`Birdeye rate limited: ${res.status} ${res.statusText}`);
            continue;
        }

        const body = await res.text().catch(() => '');
        throw new Error(`Birdeye API error: ${res.status} ${res.statusText}${body ? `\n${body}` : ''}`);
    }

    throw lastError ?? new Error('Birdeye max retries exceeded');
}

async function getTokenOverview(address, apiKey) {
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
    if (!json?.success || !data) throw new Error('Birdeye returned an unsuccessful response');

    return data;
}

async function getTokenFromSearch(address, apiKey) {
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
    return exact ?? results[0] ?? null;
}

async function getBirdeyeMeta(address, apiKey) {
    try {
        const overview = await getTokenOverview(address, apiKey);

        const symbol = typeof overview.symbol === 'string' ? overview.symbol.trim() : '';
        const name = typeof overview.name === 'string' ? overview.name.trim() : '';

        if (symbol) {
            return {
                ok: true,
                address,
                overviewSymbol: symbol,
                overviewName: name,
                searchSymbol: null,
                searchName: null,
                status: 'ok',
            };
        }

        // If overview has no symbol, try search as a fallback for debugging/dev handoff.
        const search = await getTokenFromSearch(address, apiKey);
        const searchSymbol = typeof search?.symbol === 'string' ? search.symbol.trim() : '';
        const searchName = typeof search?.name === 'string' ? search.name.trim() : '';

        return {
            ok: true,
            address,
            overviewSymbol: '',
            overviewName: name,
            searchSymbol: searchSymbol || null,
            searchName: searchName || null,
            status: 'missing_overview_symbol',
        };
    } catch (error) {
        return {
            ok: false,
            address,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
        };
    }
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

function parseCuratedLists(fileContents) {
    const lines = fileContents.split('\n');

    /** @type {Record<string, { keyLineIndex: number; addressesLineIndex: number; endLineIndex: number; entries: Array<{ lineIndex: number; indent: string; address: string; comment: string; hasComment: boolean }> }>} */
    const lists = {};

    let inLists = false;
    /** @type {string | null} */
    let currentListKey = null;
    let inAddresses = false;

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];

        if (!inLists) {
            if (line.includes('export const CURATED_TOKEN_LISTS') && line.includes('{')) {
                inLists = true;
            }
            continue;
        }

        // End of CURATED_TOKEN_LISTS object.
        if (inLists && line.trim() === '} as const satisfies Record<string, CuratedTokenList>;') break;

        if (!inAddresses) {
            const listKeyMatch = line.match(/^\s{4}([a-zA-Z0-9_]+):\s*{\s*$/);
            if (listKeyMatch) {
                currentListKey = listKeyMatch[1];
                continue;
            }

            if (currentListKey && line.includes('addresses: [')) {
                inAddresses = true;
                lists[currentListKey] = {
                    keyLineIndex: i,
                    addressesLineIndex: i,
                    endLineIndex: -1,
                    entries: [],
                };
                continue;
            }
        }

        if (inAddresses) {
            if (line.trimStart().startsWith('],')) {
                lists[currentListKey].endLineIndex = i;
                inAddresses = false;
                currentListKey = null;
                continue;
            }

            const data = getAddressLineData(line);
            if (!data) continue;
            lists[currentListKey].entries.push({
                lineIndex: i,
                indent: data.indent,
                address: data.address,
                comment: data.comment,
                hasComment: data.hasComment,
            });
        }
    }

    return { lines, lists };
}

function stablePartition(entries, isBad) {
    /** @type {typeof entries} */
    const ok = [];
    /** @type {typeof entries} */
    const bad = [];

    for (const entry of entries) {
        if (isBad(entry)) bad.push(entry);
        else ok.push(entry);
    }

    return { ok, bad };
}

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '..');

    const curatedFilePath = path.join(repoRoot, 'packages/asset-registry/src/data/curated-token-lists.ts');

    const write = getFlag('write');
    const concurrency = Math.max(1, toInt(getArg('concurrency', '2'), 2));
    const delayMs = Math.max(0, toInt(getArg('delay-ms', '200'), 200));

    const apiKey = await getBirdeyeApiKey(repoRoot);

    const fileContents = await fs.readFile(curatedFilePath, 'utf8');
    const { lines, lists } = parseCuratedLists(fileContents);

    /** @type {Array<{ listId: string; entry: (typeof lists)[string]['entries'][number] }>} */
    const allEntries = [];
    for (const [listId, list] of Object.entries(lists)) {
        for (const entry of list.entries) allEntries.push({ listId, entry });
    }

    const uniqueAddresses = Array.from(new Set(allEntries.map(x => x.entry.address)));

    console.log(
        [
            'Auditing curated token lists against Birdeye',
            `lists=${Object.keys(lists).length}`,
            `addresses=${formatNumber(allEntries.length)}`,
            `uniqueAddresses=${formatNumber(uniqueAddresses.length)}`,
            `concurrency=${concurrency}`,
            `delayMs=${delayMs}`,
            `write=${write}`,
        ].join(' | '),
    );

    /** @type {Map<string, Awaited<ReturnType<typeof getBirdeyeMeta>>>} */
    const metaByAddress = new Map();

    let done = 0;

    async function mapWithConcurrency(items, mapper) {
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

    await mapWithConcurrency(uniqueAddresses, async address => {
        const meta = await getBirdeyeMeta(address, apiKey);
        metaByAddress.set(address, meta);
        done += 1;

        // Space requests out a bit to avoid rate limits.
        await sleep(delayMs);

        if (done % 50 === 0) console.log(`progress=${formatNumber(done)}/${formatNumber(uniqueAddresses.length)}`);
    });

    /** @type {Record<string, { missing: number; errors: number; missingAddresses: string[] }>} */
    const summaryByList = {};

    for (const { listId, entry } of allEntries) {
        const meta = metaByAddress.get(entry.address);
        if (!summaryByList[listId]) summaryByList[listId] = { missing: 0, errors: 0, missingAddresses: [] };

        const isMissing =
            meta && meta.ok && meta.status === 'missing_overview_symbol'
                ? true
                : meta && meta.ok && meta.status === 'ok'
                  ? false
                  : meta && meta.ok === false
                    ? true
                    : true;

        if (isMissing) {
            summaryByList[listId].missing += 1;
            summaryByList[listId].missingAddresses.push(entry.address);
        }

        if (meta && meta.ok === false) summaryByList[listId].errors += 1;
    }

    console.log('\nMissing/unknown symbols by list (Birdeye token_overview):');
    for (const listId of Object.keys(summaryByList)) {
        const s = summaryByList[listId];
        if (s.missing === 0) continue;
        console.log(
            `- ${listId}: missing=${formatNumber(s.missing)}${s.errors ? ` (errors=${formatNumber(s.errors)})` : ''}`,
        );
    }

    if (!write) {
        console.log('\nDry run. Re-run with --write to update packages/asset-registry/src/data/curated-token-lists.ts.');
        return;
    }

    // Apply edits list-by-list, from bottom to top to preserve indices.
    const listEntriesSorted = Object.entries(lists).sort((a, b) => b[1].addressesLineIndex - a[1].addressesLineIndex);

    for (const [listId, list] of listEntriesSorted) {
        const firstIndent = list.entries[0]?.indent ?? '            ';

        const { ok, bad } = stablePartition(list.entries, entry => {
            const meta = metaByAddress.get(entry.address);
            if (!meta) return true;
            if (meta.ok === false) return true;
            return meta.status !== 'ok';
        });

        /** @type {string[]} */
        const nextLines = [];

        function formatLine(entry, forceOndoComment) {
            const meta = metaByAddress.get(entry.address);

            if (forceOndoComment) {
                const overviewName = meta && meta.ok ? meta.overviewName : '';
                const searchName = meta && meta.ok ? meta.searchName : '';
                const rawName = overviewName || searchName || '';
                const cleanedName = cleanOndoTokenName(rawName);

                const overviewSymbol = meta && meta.ok ? meta.overviewSymbol : '';
                const searchSymbol = meta && meta.ok ? meta.searchSymbol : '';
                const symbol = overviewSymbol || searchSymbol || '';

                const label = cleanedName || sanitizeInlineComment(rawName) || (symbol ? `Unknown (${symbol})` : 'Unknown');
                return `${entry.indent}'${entry.address}', // ${sanitizeInlineComment(label)}`;
            }

            if (entry.hasComment) return `${entry.indent}'${entry.address}', // ${entry.comment}`;

            // Only add a label comment for "bad" entries (keeps diffs smaller).
            const isBad =
                meta && meta.ok
                    ? meta.status !== 'ok'
                    : meta && meta.ok === false
                      ? true
                      : true;

            if (!isBad) return `${entry.indent}'${entry.address}',`;

            const overviewName = meta && meta.ok ? meta.overviewName : '';
            const searchName = meta && meta.ok ? meta.searchName : '';
            const rawName = overviewName || searchName || '';
            const label = sanitizeInlineComment(rawName);

            return label ? `${entry.indent}'${entry.address}', // ${label}` : `${entry.indent}'${entry.address}',`;
        }

        for (const entry of ok) nextLines.push(formatLine(entry, listId === 'ondo'));

        if (bad.length > 0) {
            nextLines.push('');
            nextLines.push(
                `${firstIndent}// Missing Birdeye token_overview symbol (these would show as "???" without filtering).`,
            );
            for (const entry of bad) nextLines.push(formatLine(entry, listId === 'ondo'));
        }

        // Replace the old addresses block (exclusive) with the new one.
        const start = list.addressesLineIndex + 1;
        const end = list.endLineIndex; // keep the closing '],'
        lines.splice(start, end - start, ...nextLines);
    }

    await fs.writeFile(curatedFilePath, lines.join('\n'));
    console.log(`\nUpdated ${path.relative(repoRoot, curatedFilePath)}`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

