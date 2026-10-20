import { describe, expect, it } from 'bun:test';

import {
    BIRDEYE_METADATA_BATCH_SIZE,
    parseBirdeyeMetadataPayload,
    parseSolanaDataAssetsPayload,
    solanaDataRowToUpsert,
    syncSolanaDataAssets,
    type BirdeyeMetadataResult,
    type SolanaDataAssetUpsert,
    type SolanaDataCronDeps,
    type SolanaDataFetchResult,
    type SolanaDataJobsRepo,
    type SolanaDataProviderMetadataUpdate,
} from './crons.solanaData';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        token: 'USDC',
        mint_address: USDC,
        group: 'Stablecoins',
        category: 'Fiat-Backed',
        class: 'USD Stablecoins',
        allium_asset_class: 'stablecoins',
        rwa_asset_class: 'Stablecoins',
        allium_asset_value_usd: '6.686697914433202E9',
        rwa_asset_value_usd: '6.617043551629716E9',
        coingecko_market_cap: '7.267700692825296E10',
        ...overrides,
    };
}

function envelope(rows: unknown[], extra: Record<string, unknown> = {}): unknown {
    return {
        source: 'solana-data',
        data: { generatedAt: '2026-10-13T13:01:17.389304+00:00', truncated: false, rows, ...extra },
    };
}

describe('parseSolanaDataAssetsPayload', () => {
    it('normalizes the live envelope: taxonomy, numeric strings, generatedAt', () => {
        const parsed = parseSolanaDataAssetsPayload(envelope([rawRow()]));
        expect(parsed).not.toBeNull();
        expect(parsed!.generatedAt).toBe('2026-10-13T13:01:17.389304+00:00');
        expect(parsed!.truncated).toBe(false);
        expect(parsed!.rows).toHaveLength(1);
        const row = parsed!.rows[0]!;
        expect(row.mint).toBe(USDC);
        expect(row.symbol).toBe('USDC');
        expect(row.group).toBe('Stablecoins');
        expect(row.category).toBe('Fiat-Backed');
        expect(row.assetClass).toBe('USD Stablecoins');
        expect(row.alliumValueUsd).toBeCloseTo(6_686_697_914.43, 0);
        expect(row.rwaValueUsd).toBeCloseTo(6_617_043_551.63, 0);
        expect(row.marketCapUsd).toBeCloseTo(72_677_006_928.25, 0);
        expect(parsed!.invalidMint).toBe(0);
        expect(parsed!.invalidNumeric).toBe(0);
    });

    it('treats empty / null values as null and counts garbage numerics without dropping the row', () => {
        const parsed = parseSolanaDataAssetsPayload(
            envelope([
                rawRow({
                    group: null,
                    allium_asset_class: '',
                    allium_asset_value_usd: '',
                    rwa_asset_value_usd: null,
                    coingecko_market_cap: 'n/a',
                }),
            ]),
        );
        const row = parsed!.rows[0]!;
        expect(row.group).toBeNull();
        expect(row.alliumClass).toBeNull();
        expect(row.alliumValueUsd).toBeNull();
        expect(row.rwaValueUsd).toBeNull();
        expect(row.marketCapUsd).toBeNull();
        expect(parsed!.invalidNumeric).toBe(1);
    });

    it('drops rows with a bad mint or empty symbol, dedupes by mint (first wins), keeps upstream order', () => {
        const parsed = parseSolanaDataAssetsPayload(
            envelope([
                rawRow({ token: 'USDC', mint_address: USDC, group: 'first' }),
                rawRow({ token: 'nope', mint_address: 'not-a-mint' }),
                rawRow({ token: '', mint_address: USDT }),
                rawRow({ token: 'USDC2', mint_address: USDC, group: 'second' }),
                rawRow({ token: 'BONK', mint_address: BONK, group: 'Crypto Native' }),
                'not an object',
            ]),
        );
        expect(parsed!.rows.map(r => r.mint)).toEqual([USDC, BONK]);
        expect(parsed!.rows[0]!.group).toBe('first');
        expect(parsed!.invalidMint).toBe(3);
        expect(parsed!.duplicateMint).toBe(1);
    });

    it('rejects envelopes without data.rows and reports truncation', () => {
        expect(parseSolanaDataAssetsPayload(null)).toBeNull();
        expect(parseSolanaDataAssetsPayload({ rows: [] })).toBeNull();
        expect(parseSolanaDataAssetsPayload({ data: { rows: 'x' } })).toBeNull();
        const truncated = parseSolanaDataAssetsPayload(envelope([rawRow()], { truncated: true }));
        expect(truncated!.truncated).toBe(true);
        const noStamp = parseSolanaDataAssetsPayload({ data: { rows: [rawRow()] } });
        expect(noStamp!.generatedAt).toBeNull();
    });
});

describe('parseBirdeyeMetadataPayload', () => {
    it('keeps raw https / ipfs logo URLs, drops other schemes and "unknown" names, keeps misses as null fields', () => {
        const parsed = parseBirdeyeMetadataPayload(
            {
                success: true,
                data: {
                    [USDC]: { symbol: 'USDC', name: 'USD Coin', logo_uri: 'https://img.example/usdc.png' },
                    [BONK]: {
                        symbol: 'BONK',
                        name: 'unknown',
                        logoURI: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
                    },
                    [JUP]: { symbol: 'JUP', name: 'Jupiter', logo_uri: 'data:image/png;base64,AAAA' },
                    [WIF]: null,
                },
            },
            [USDC, BONK, JUP, WIF, USDT],
        );
        expect(parsed).not.toBeNull();
        expect(parsed!.get(USDC)).toEqual({
            symbol: 'USDC',
            name: 'USD Coin',
            logoURI: 'https://img.example/usdc.png',
        });
        expect(parsed!.get(BONK)).toEqual({
            symbol: 'BONK',
            name: null,
            logoURI: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        });
        expect(parsed!.get(JUP)).toEqual({ symbol: 'JUP', name: 'Jupiter', logoURI: null });
        expect(parsed!.has(WIF)).toBe(false);
        expect(parsed!.has(USDT)).toBe(false);
    });

    it('rejects a non-success envelope', () => {
        expect(parseBirdeyeMetadataPayload({ success: false, data: {} }, [USDC])).toBeNull();
        expect(parseBirdeyeMetadataPayload({ success: true }, [USDC])).toBeNull();
    });
});

describe('solanaDataRowToUpsert', () => {
    it('maps the taxonomy to column names, preserves rank, and snapshots the raw row', () => {
        const row = parseSolanaDataAssetsPayload(envelope([rawRow()]))!.rows[0]!;
        const upsert = solanaDataRowToUpsert(row, 7, '2026-10-13T13:01:17Z', 1_000);
        expect(upsert.mint).toBe(USDC);
        expect(upsert.groupName).toBe('Stablecoins');
        expect(upsert.assetClass).toBe('USD Stablecoins');
        expect(upsert.sourceRank).toBe(7);
        expect(upsert.sourceGeneratedAt).toBe('2026-10-13T13:01:17Z');
        expect(upsert.lastSeenAt).toBe(1_000);
        expect(upsert.lastSyncedAt).toBe(1_000);
        expect(JSON.parse(upsert.rawJson)).toMatchObject({ token: 'USDC', mint_address: USDC });
    });
});

interface StoredRow extends SolanaDataAssetUpsert {
    isActive: boolean;
    providerName: string | null;
    providerLogoURI: string | null;
    providerFetchedAt: number | null;
}

interface Harness {
    deps: SolanaDataCronDeps;
    rows: Map<string, StoredRow>;
    /** Mints the fake repo reports as already having a platform logo. */
    platformLogos: Set<string>;
    birdeyeCalls: string[][];
    setFetch(result: SolanaDataFetchResult): void;
    setBirdeye(fn: (batch: readonly string[]) => BirdeyeMetadataResult): void;
    clock: { now: number };
}

function makeHarness(): Harness {
    const rows = new Map<string, StoredRow>();
    const platformLogos = new Set<string>();
    const birdeyeCalls: string[][] = [];
    const clock = { now: 1_700_000_000_000 };
    let fetchResult: SolanaDataFetchResult = { ok: false, reason: 'error', message: 'unset' };
    let birdeyeFn: (batch: readonly string[]) => BirdeyeMetadataResult = () => ({ ok: true, byMint: new Map() });

    const repo: SolanaDataJobsRepo = {
        async listActiveCount() {
            return [...rows.values()].filter(r => r.isActive).length;
        },
        async upsertLatest(batch) {
            for (const row of batch) {
                const existing = rows.get(row.mint);
                if (existing && existing.lastSeenAt > row.lastSeenAt) continue;
                rows.set(row.mint, {
                    ...row,
                    isActive: true,
                    providerName: existing?.providerName ?? null,
                    providerLogoURI: existing?.providerLogoURI ?? null,
                    providerFetchedAt: existing?.providerFetchedAt ?? null,
                });
            }
        },
        async deactivateMissing(mints, lastSyncedAt) {
            const present = new Set(mints);
            let count = 0;
            for (const row of rows.values()) {
                if (row.isActive && row.lastSeenAt < lastSyncedAt && !present.has(row.mint)) {
                    row.isActive = false;
                    row.lastSyncedAt = lastSyncedAt;
                    count += 1;
                }
            }
            return count;
        },
        async listMintsNeedingProviderMetadata(limit, staleBeforeMs) {
            return [...rows.values()]
                .filter(r => r.isActive && !platformLogos.has(r.mint))
                .filter(r => r.providerFetchedAt === null || r.providerFetchedAt < staleBeforeMs)
                .sort((a, b) => a.sourceRank - b.sourceRank)
                .slice(0, limit)
                .map(r => r.mint);
        },
        async updateProviderMetadata(updates: readonly SolanaDataProviderMetadataUpdate[]) {
            for (const update of updates) {
                const row = rows.get(update.mint);
                if (!row) continue;
                row.providerName = update.name;
                row.providerLogoURI = update.logoURI;
                row.providerFetchedAt = update.fetchedAt;
            }
        },
    };

    const deps: SolanaDataCronDeps = {
        repo,
        solanaData: { fetchAssets: async () => fetchResult },
        birdeye: {
            async fetchTokenMetadataMultiple(batch) {
                birdeyeCalls.push([...batch]);
                return birdeyeFn(batch);
            },
        },
        now: () => clock.now,
    };

    return {
        deps,
        rows,
        platformLogos,
        birdeyeCalls,
        clock,
        setFetch: result => {
            fetchResult = result;
        },
        setBirdeye: fn => {
            birdeyeFn = fn;
        },
    };
}

function okFetch(rows: unknown[], extra: Record<string, unknown> = {}): SolanaDataFetchResult {
    const parsed = parseSolanaDataAssetsPayload(envelope(rows, extra));
    if (!parsed) throw new Error('fixture did not parse');
    return { ok: true, ...parsed };
}

const QUIET = { providerLimit: 0 };

describe('syncSolanaDataAssets', () => {
    it('upserts every row in upstream order and reports the taxonomy canary', async () => {
        const h = makeHarness();
        h.setFetch(okFetch([rawRow(), rawRow({ token: 'BONK', mint_address: BONK, group: 'Crypto Native' })]));
        const result = await syncSolanaDataAssets(h.deps, QUIET);
        expect(result.ok).toBe(true);
        expect(result.processed).toBe(2);
        expect(result.fetched).toBe(2);
        expect(result.withGroup).toBe(2);
        expect(result.deactivated).toBe(0);
        expect(result.generatedAt).toBe('2026-10-13T13:01:17.389304+00:00');
        expect(h.rows.get(USDC)!.sourceRank).toBe(0);
        expect(h.rows.get(BONK)!.sourceRank).toBe(1);
        expect(h.rows.get(BONK)!.sourceGeneratedAt).toBe('2026-10-13T13:01:17.389304+00:00');
    });

    it('returns ok:false on upstream failure and touches nothing', async () => {
        const h = makeHarness();
        h.setFetch(okFetch([rawRow()]));
        await syncSolanaDataAssets(h.deps, QUIET);
        h.setFetch({ ok: false, reason: 'http_error', status: 503 });
        const result = await syncSolanaDataAssets(h.deps, QUIET);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('http_error');
        expect(result.status).toBe(503);
        expect(h.rows.get(USDC)!.isActive).toBe(true);
    });

    it('skips a truncated body as invalid_payload without deactivating', async () => {
        const h = makeHarness();
        h.setFetch(okFetch([rawRow(), rawRow({ token: 'BONK', mint_address: BONK })]));
        await syncSolanaDataAssets(h.deps, QUIET);
        h.setFetch(okFetch([rawRow()], { truncated: true }));
        const result = await syncSolanaDataAssets(h.deps, QUIET);
        expect(result.ok).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('invalid_payload');
        expect(h.rows.get(BONK)!.isActive).toBe(true);
    });

    it('skips a suspicious drop (< 70% of the active set) and keeps every row active', async () => {
        const h = makeHarness();
        h.setFetch(
            okFetch([
                rawRow(),
                rawRow({ token: 'USDT', mint_address: USDT }),
                rawRow({ token: 'BONK', mint_address: BONK }),
                rawRow({ token: 'JUP', mint_address: JUP }),
            ]),
        );
        await syncSolanaDataAssets(h.deps, QUIET);
        h.setFetch(okFetch([rawRow()]));
        const result = await syncSolanaDataAssets(h.deps, QUIET);
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('suspicious_drop');
        expect(result.existingActiveCount).toBe(4);
        expect(result.nextActiveCount).toBe(1);
        expect([...h.rows.values()].every(r => r.isActive)).toBe(true);
    });

    it('deactivates rows the upstream stopped returning and reactivates them when they come back', async () => {
        // Four rows so losing one (75% kept) stays above the 70% suspicious-drop guard.
        const full = [
            rawRow(),
            rawRow({ token: 'USDT', mint_address: USDT }),
            rawRow({ token: 'JUP', mint_address: JUP }),
            rawRow({ token: 'BONK', mint_address: BONK }),
        ];
        const h = makeHarness();
        h.setFetch(okFetch(full));
        await syncSolanaDataAssets(h.deps, QUIET);
        h.clock.now += 3_600_000;
        h.setFetch(okFetch(full.slice(0, 3)));
        const second = await syncSolanaDataAssets(h.deps, QUIET);
        expect(second.skipped).toBeUndefined();
        expect(second.deactivated).toBe(1);
        expect(h.rows.get(BONK)!.isActive).toBe(false);
        expect(h.rows.get(BONK)!.lastSyncedAt).toBe(h.clock.now);

        h.clock.now += 3_600_000;
        h.setFetch(okFetch(full));
        const third = await syncSolanaDataAssets(h.deps, QUIET);
        expect(third.deactivated).toBe(0);
        expect(h.rows.get(BONK)!.isActive).toBe(true);
        expect(h.rows.get(BONK)!.sourceRank).toBe(3);
    });

    it('an older overlapping run neither overwrites nor deactivates what a newer run wrote', async () => {
        const h = makeHarness();
        const full = [
            rawRow(),
            rawRow({ token: 'USDT', mint_address: USDT }),
            rawRow({ token: 'JUP', mint_address: JUP }),
            rawRow({ token: 'BONK', mint_address: BONK, group: 'Crypto Native' }),
        ];
        // Newer run (later clock) lands first with BONK present.
        h.clock.now = 2_000_000_000_000;
        h.setFetch(okFetch(full));
        await syncSolanaDataAssets(h.deps, QUIET);
        // Older run (earlier clock) finishes afterwards with a stale snapshot lacking BONK.
        h.clock.now = 1_900_000_000_000;
        h.setFetch(okFetch([...full.slice(0, 3), rawRow({ token: 'WIF', mint_address: WIF })]));
        const stale = await syncSolanaDataAssets(h.deps, QUIET);
        expect(stale.ok).toBe(true);
        expect(stale.deactivated).toBe(0);
        expect(h.rows.get(BONK)!.isActive).toBe(true);
        expect(h.rows.get(BONK)!.groupName).toBe('Crypto Native');
        expect(h.rows.get(USDC)!.lastSeenAt).toBe(2_000_000_000_000);
        // The stale run may still add a mint the newer run did not know.
        expect(h.rows.get(WIF)!.isActive).toBe(true);
    });

    it('fills provider metadata only for mints without a platform logo, in batches of 50, stamping misses too', async () => {
        const h = makeHarness();
        const mints = [USDC, USDT, BONK, JUP, WIF];
        h.setFetch(okFetch(mints.map((mint, i) => rawRow({ token: `T${i}`, mint_address: mint }))));
        h.platformLogos.add(USDC);
        h.setBirdeye(batch => ({
            ok: true,
            byMint: new Map(
                batch
                    .filter(mint => mint === USDT || mint === BONK)
                    .map(mint => [
                        mint,
                        { symbol: 'X', name: `Name ${mint.slice(0, 4)}`, logoURI: `https://img/${mint}.png` },
                    ]),
            ),
        }));
        const result = await syncSolanaDataAssets(h.deps, { providerLimit: 500, delayMs: 0 });
        expect(result.ok).toBe(true);
        expect(result.providerLooked).toBe(4);
        expect(result.providerHits).toBe(2);
        expect(result.providerFailed).toBe(0);
        expect(h.birdeyeCalls).toHaveLength(1);
        expect(h.birdeyeCalls[0]).toEqual([USDT, BONK, JUP, WIF]);
        expect(h.birdeyeCalls[0]!.length).toBeLessThanOrEqual(BIRDEYE_METADATA_BATCH_SIZE);
        expect(h.rows.get(USDC)!.providerFetchedAt).toBeNull();
        expect(h.rows.get(USDT)!.providerLogoURI).toBe(`https://img/${USDT}.png`);
        expect(h.rows.get(JUP)!.providerLogoURI).toBeNull();
        expect(h.rows.get(JUP)!.providerFetchedAt).toBe(h.clock.now);

        // Next hourly run: misses are not re-queried until the refresh window passes.
        const again = await syncSolanaDataAssets(h.deps, { providerLimit: 500, delayMs: 0 });
        expect(again.providerLooked).toBe(0);
        expect(h.birdeyeCalls).toHaveLength(1);

        h.clock.now += 8 * 86_400_000;
        const later = await syncSolanaDataAssets(h.deps, { providerLimit: 500, delayMs: 0 });
        expect(later.providerLooked).toBe(4);
    });

    it('keeps provider metadata across the hourly upsert', async () => {
        const h = makeHarness();
        h.setFetch(okFetch([rawRow({ token: 'JUP', mint_address: JUP })]));
        h.setBirdeye(() => ({
            ok: true,
            byMint: new Map([[JUP, { symbol: 'JUP', name: 'Jupiter', logoURI: 'https://img/jup.png' }]]),
        }));
        await syncSolanaDataAssets(h.deps, { providerLimit: 500, delayMs: 0 });
        expect(h.rows.get(JUP)!.providerName).toBe('Jupiter');
        h.setFetch(okFetch([rawRow({ token: 'JUP', mint_address: JUP, group: 'Crypto Native' })]));
        await syncSolanaDataAssets(h.deps, QUIET);
        expect(h.rows.get(JUP)!.groupName).toBe('Crypto Native');
        expect(h.rows.get(JUP)!.providerName).toBe('Jupiter');
        expect(h.rows.get(JUP)!.providerLogoURI).toBe('https://img/jup.png');
    });

    it('does not stamp a batch whose Birdeye call failed, so it is retried next run', async () => {
        const h = makeHarness();
        h.setFetch(okFetch([rawRow({ token: 'JUP', mint_address: JUP })]));
        h.setBirdeye(() => ({ ok: false, status: 429, message: 'rate limited' }));
        const result = await syncSolanaDataAssets(h.deps, { providerLimit: 500, delayMs: 0 });
        expect(result.ok).toBe(true);
        expect(result.providerFailed).toBe(1);
        expect(result.providerLooked).toBe(0);
        expect(h.rows.get(JUP)!.providerFetchedAt).toBeNull();
    });

    it('honours providerLimit and rejects non-numeric args', async () => {
        const h = makeHarness();
        const mints = [USDC, USDT, BONK];
        h.setFetch(okFetch(mints.map((mint, i) => rawRow({ token: `T${i}`, mint_address: mint }))));
        const result = await syncSolanaDataAssets(h.deps, { providerLimit: 2, delayMs: 0 });
        expect(result.providerLooked).toBe(2);
        expect(h.birdeyeCalls[0]).toEqual([USDC, USDT]);
        await expect(syncSolanaDataAssets(h.deps, { providerLimit: 'lots' })).rejects.toThrow();
    });
});
