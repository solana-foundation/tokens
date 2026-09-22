import { describe, expect, test } from 'bun:test';

import type { CronDeps } from './crons';
import { InvalidArgsError } from './crons';
import {
    logoObjectKey,
    parseLogoSyncArgs,
    shouldSkipUnchanged,
    syncLogos,
    type LogoSyncCandidate,
    type LogoSyncCronDeps,
    type LogoSyncFailure,
    type LogoSyncSuccess,
} from './crons.logoSync';
import { sha256Hex } from './logoSource';
import type { LogoStorePutOptions } from '../logoStore';

const NOW = 1_758_500_000_000; // 2025-09-22T00:13:20Z-ish; only relative math matters
const DAY = 86_400_000;
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const MINT_A = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE = 'https://storage.googleapis.com/tokens-asset-logos-test';

/** Valid PNG signature + padding: enough for the sniffer; the normalizer is stubbed. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

type Script = Record<string, () => Response>;

function scriptedFetch(script: Script, calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        for (const [prefix, make] of Object.entries(script)) {
            if (url.startsWith(prefix)) return make();
        }
        return new Response('not scripted', { status: 599 });
    }) as unknown as typeof fetch;
}

function png(): Response {
    return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
}

function candidate(overrides: Partial<LogoSyncCandidate> = {}): LogoSyncCandidate {
    return {
        mint: MINT_A,
        source_url: `https://ipfs.io/ipfs/${CID}/logo.png`,
        source_table: 'variant_markets_latest',
        logo_source_hash: null,
        logo_cdn_url: null,
        logo_synced_at: null,
        attempts: 0,
        ...overrides,
    };
}

interface Harness {
    deps: LogoSyncCronDeps;
    calls: string[];
    puts: Array<{ key: string; bytes: Uint8Array; opts: LogoStorePutOptions }>;
    successes: LogoSyncSuccess[];
    failures: LogoSyncFailure[];
    listArgs: unknown[];
}

function makeHarness(
    candidates: LogoSyncCandidate[],
    script: Script,
    opts: { pinata?: boolean; curated?: string[]; normalizeFails?: boolean } = {},
): Harness {
    const calls: string[] = [];
    const puts: Harness['puts'] = [];
    const successes: LogoSyncSuccess[] = [];
    const failures: LogoSyncFailure[] = [];
    const listArgs: unknown[] = [];
    const base = {
        now: () => NOW,
        curated: { getAllCuratedMintsInOrder: () => opts.curated ?? [MINT_A, MINT_B] },
    } as unknown as CronDeps;
    const deps: LogoSyncCronDeps = {
        base,
        repo: {
            async listCandidates(args) {
                listArgs.push(args);
                return candidates;
            },
            async recordSuccess(row) {
                successes.push(row);
            },
            async recordFailure(row) {
                failures.push(row);
            },
        },
        store: {
            async put(key, bytes, putOpts) {
                puts.push({ key, bytes, opts: putOpts });
            },
            publicUrl: key => `${BASE}/${key}`,
        },
        normalizer: {
            async normalize(bytes, contentType) {
                if (opts.normalizeFails) throw new Error('boom');
                return { webp: new Uint8Array([contentType.length, bytes.length]), width: 256, height: 256 };
            },
        },
        fetchImpl: scriptedFetch(script, calls),
        ...(opts.pinata === false ? {} : { pinataGatewayHost: 'tokens.mypinata.cloud', pinataGatewayToken: 'tok' }),
    };
    return { deps, calls, puts, successes, failures, listArgs };
}

const fastArgs = { delayMs: 0, fetchTimeoutMs: 1000 };

describe('parseLogoSyncArgs', () => {
    test('defaults', () => {
        const args = parseLogoSyncArgs({});
        expect(args.limit).toBe(200);
        expect(args.concurrency).toBe(3);
        expect(args.delayMs).toBe(250);
        expect(args.budgetMs).toBe(480_000);
        expect(args.resyncDays).toBe(7);
        expect(args.maxBytes).toBe(2 * 1024 * 1024);
        expect(args.force).toBe(false);
        expect(args.mints).toBeUndefined();
    });

    test('clamps and caps; maxBytes can never exceed 2 MiB', () => {
        const args = parseLogoSyncArgs({ limit: 5000, concurrency: 99, maxBytes: 50_000_000, force: true, mints: [' a ', 'b', 'a'] });
        expect(args.limit).toBe(1000);
        expect(args.concurrency).toBe(6);
        expect(args.maxBytes).toBe(2 * 1024 * 1024);
        expect(args.force).toBe(true);
        expect(args.mints).toEqual(['a', 'b']);
    });

    test('rejects malformed args', () => {
        expect(() => parseLogoSyncArgs({ limit: 'ten' })).toThrow(InvalidArgsError);
        expect(() => parseLogoSyncArgs({ mints: 'abc' })).toThrow(InvalidArgsError);
        expect(() => parseLogoSyncArgs({ force: 'yes' })).toThrow(InvalidArgsError);
        expect(() => parseLogoSyncArgs('nope')).toThrow(InvalidArgsError);
    });
});

describe('shouldSkipUnchanged', () => {
    test('same hash, recent copy => skip; stale copy => re-sync; IPFS copy never ages out', async () => {
        const httpsUrl = 'https://static.jup.ag/jup/icon.png';
        const hash = await sha256Hex(httpsUrl);
        const recent = candidate({ source_url: httpsUrl, logo_source_hash: hash, logo_cdn_url: `${BASE}/x`, logo_synced_at: NOW - 2 * DAY });
        const stale = candidate({ ...recent, logo_synced_at: NOW - 8 * DAY });
        expect(shouldSkipUnchanged(recent, hash, NOW, 7)).toBe(true);
        expect(shouldSkipUnchanged(stale, hash, NOW, 7)).toBe(false);
        expect(shouldSkipUnchanged(recent, 'otherhash', NOW, 7)).toBe(false);
        expect(shouldSkipUnchanged(candidate({ ...recent, logo_cdn_url: null }), hash, NOW, 7)).toBe(false);

        const ipfsUrl = `https://ipfs.io/ipfs/${CID}`;
        const ipfsHash = await sha256Hex(ipfsUrl);
        const ipfsOld = candidate({ source_url: ipfsUrl, logo_source_hash: ipfsHash, logo_cdn_url: `${BASE}/y`, logo_synced_at: NOW - 400 * DAY });
        expect(shouldSkipUnchanged(ipfsOld, ipfsHash, NOW, 7)).toBe(true);
    });
});

describe('syncLogos', () => {
    test('walks the plan in order: pinata 429, origin skipped for a public gateway, dexscreener wins', async () => {
        const h = makeHarness([candidate()], {
            'https://tokens.mypinata.cloud/': () => new Response('slow down', { status: 429, headers: { 'retry-after': '900' } }),
            'https://dd.dexscreener.com/': png,
        });
        const out = await syncLogos(h.deps, fastArgs);

        expect(out.ok).toBe(true);
        expect(out.synced).toBe(1);
        expect(out.failed).toBe(0);
        expect(h.calls).toEqual([
            `https://tokens.mypinata.cloud/ipfs/${CID}/logo.png`,
            `https://dd.dexscreener.com/ds-data/tokens/solana/${MINT_A}.png`,
        ]);
        expect(h.calls.some(u => u.includes('ipfs.io'))).toBe(false);

        expect(h.puts).toHaveLength(1);
        expect(h.puts[0]!.key).toBe(logoObjectKey(MINT_A));
        expect(h.puts[0]!.key).toBe(`solana/${MINT_A}.webp`);
        expect(h.puts[0]!.opts.contentType).toBe('image/webp');
        expect(h.puts[0]!.opts.cacheControl).toBe('public, max-age=86400');
        expect(h.puts[0]!.opts.metadata?.['source-kind']).toBe('dexscreener');

        expect(h.successes).toHaveLength(1);
        const row = h.successes[0]!;
        expect(row.sourceKind).toBe('dexscreener');
        expect(row.cdnUrl).toBe(`${BASE}/solana/${MINT_A}.webp`);
        expect(row.contentType).toBe('image/png');
        expect(row.sourceHash).toBe(await sha256Hex(candidate().source_url));
        expect(row.sourceUrl).toBe(candidate().source_url);

        const bySource = out.bySource as Record<string, { ok: number; fail: number }>;
        expect(bySource.pinata).toEqual({ ok: 0, fail: 1 });
        expect(bySource.dexscreener).toEqual({ ok: 1, fail: 0 });
        expect(bySource.origin).toEqual({ ok: 0, fail: 0 });
    });

    test('pinata succeeds first for an IPFS source; SVG is rasterised', async () => {
        const h = makeHarness([candidate({ source_url: `ipfs://${CID}` })], {
            'https://tokens.mypinata.cloud/': () => new Response(SVG_BYTES, { status: 200, headers: { 'content-type': 'text/plain' } }),
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect(h.calls).toEqual([`https://tokens.mypinata.cloud/ipfs/${CID}`]);
        expect(h.successes[0]!.sourceKind).toBe('pinata');
        expect(h.successes[0]!.contentType).toBe('image/svg+xml');
    });

    test('dedicated pinata 403 falls through our gateway then origin then dexscreener', async () => {
        const url = `https://other.mypinata.cloud/ipfs/${CID}`;
        const h = makeHarness([candidate({ source_url: url })], {
            'https://tokens.mypinata.cloud/': () => new Response('nope', { status: 504 }),
            'https://other.mypinata.cloud/': () => new Response('forbidden', { status: 403 }),
            'https://dd.dexscreener.com/': png,
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect(h.calls.map(u => new URL(u).hostname)).toEqual(['tokens.mypinata.cloud', 'other.mypinata.cloud', 'dd.dexscreener.com']);
        expect(h.successes[0]!.sourceKind).toBe('dexscreener');
    });

    test('unchanged hash synced 2 days ago is skipped without any fetch', async () => {
        const url = 'https://static.jup.ag/jup/icon.png';
        const h = makeHarness(
            [candidate({ source_url: url, logo_source_hash: await sha256Hex(url), logo_cdn_url: `${BASE}/solana/${MINT_A}.webp`, logo_synced_at: NOW - 2 * DAY })],
            { 'https://static.jup.ag/': png },
        );
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.skippedUnchanged).toBe(1);
        expect(out.synced).toBe(0);
        expect(out.ok).toBe(true);
        expect(h.calls).toEqual([]);
        expect(h.puts).toEqual([]);
    });

    test('unchanged hash synced 8 days ago is re-fetched from origin', async () => {
        const url = 'https://static.jup.ag/jup/icon.png';
        const h = makeHarness(
            [candidate({ source_url: url, logo_source_hash: await sha256Hex(url), logo_cdn_url: `${BASE}/solana/${MINT_A}.webp`, logo_synced_at: NOW - 8 * DAY })],
            { 'https://static.jup.ag/': png },
        );
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.skippedUnchanged).toBe(0);
        expect(out.synced).toBe(1);
        expect(h.calls).toEqual([url]);
        expect(h.successes[0]!.sourceKind).toBe('origin');
    });

    test('changed hash re-syncs even when a recent copy exists', async () => {
        const url = 'https://static.jup.ag/jup/icon-v2.png';
        const h = makeHarness(
            [candidate({ source_url: url, logo_source_hash: await sha256Hex('https://static.jup.ag/jup/icon.png'), logo_cdn_url: `${BASE}/x`, logo_synced_at: NOW - DAY })],
            { 'https://static.jup.ag/': png },
        );
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect(h.successes[0]!.sourceHash).toBe(await sha256Hex(url));
    });

    test('force bypasses the unchanged skip', async () => {
        const url = 'https://static.jup.ag/jup/icon.png';
        const h = makeHarness(
            [candidate({ source_url: url, logo_source_hash: await sha256Hex(url), logo_cdn_url: `${BASE}/x`, logo_synced_at: NOW - DAY })],
            { 'https://static.jup.ag/': png },
        );
        const out = await syncLogos(h.deps, { ...fastArgs, force: true, mints: [MINT_A] });
        expect(out.synced).toBe(1);
        expect((h.listArgs[0] as { force: boolean; mints?: string[] }).force).toBe(true);
        expect((h.listArgs[0] as { mints?: string[] }).mints).toEqual([MINT_A]);
    });

    test('2 MiB cap: an oversized body is rejected and the next source is tried', async () => {
        const url = 'https://cdn.example/huge.png';
        const h = makeHarness([candidate({ source_url: url })], {
            'https://cdn.example/': () => new Response(PNG_BYTES, { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }),
            'https://dd.dexscreener.com/': png,
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect((out.bySource as Record<string, { fail: number }>).origin.fail).toBe(1);
        expect(h.successes[0]!.sourceKind).toBe('dexscreener');
    });

    test('non-image bodies (HTML 200 from a gateway) are not accepted', async () => {
        const h = makeHarness([candidate({ source_url: 'https://cdn.example/a.png' })], {
            'https://cdn.example/': () => new Response('<!doctype html><html>blocked</html>', { status: 200, headers: { 'content-type': 'image/png' } }),
            'https://dd.dexscreener.com/': png,
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect(h.successes[0]!.sourceKind).toBe('dexscreener');
    });

    test('jupiter lookup is the last resort and its icon goes through the direct rules', async () => {
        const h = makeHarness([candidate({ source_url: 'https://cdn.example/a.png' })], {
            'https://cdn.example/': () => new Response('err', { status: 500 }),
            'https://dd.dexscreener.com/': () => new Response('missing', { status: 404 }),
            'https://lite-api.jup.ag/': () =>
                new Response(JSON.stringify([{ id: MINT_A, icon: 'https://static.jup.ag/jup/icon.png' }]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            'https://static.jup.ag/': png,
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.synced).toBe(1);
        expect(h.successes[0]!.sourceKind).toBe('jupiter');
        expect(h.calls.at(-1)).toBe('https://static.jup.ag/jup/icon.png');
    });

    test('total failure for a mint records a failure with every source reason and keeps the batch alive', async () => {
        const h = makeHarness(
            [candidate({ mint: MINT_A, source_url: `https://ipfs.io/ipfs/${CID}` }), candidate({ mint: MINT_B, source_url: 'https://good.example/b.png' })],
            {
                'https://tokens.mypinata.cloud/': () => new Response('slow down', { status: 429 }),
                'https://dd.dexscreener.com/ds-data/tokens/solana/JUP': () => new Response('missing', { status: 404 }),
                'https://lite-api.jup.ag/': () => new Response('[]', { status: 200 }),
                'https://good.example/': png,
                'https://dd.dexscreener.com/': png,
            },
        );
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.ok).toBe(true);
        expect(out.synced).toBe(1);
        expect(out.failed).toBe(1);
        expect(h.failures).toHaveLength(1);
        expect(h.failures[0]!.mint).toBe(MINT_A);
        expect(h.failures[0]!.error).toContain('pinata:http_429(429)');
        expect(h.failures[0]!.error).toContain('dexscreener:http_404(404)');
        expect(h.failures[0]!.error).toContain('jupiter:lookup_no_icon');
        expect(h.successes.map(s => s.mint)).toEqual([MINT_B]);
    });

    test('ok is false only when every attempted mint failed', async () => {
        const h = makeHarness([candidate({ source_url: 'https://bad.example/a.png' })], {
            'https://bad.example/': () => new Response('err', { status: 500 }),
            'https://dd.dexscreener.com/': () => new Response('missing', { status: 404 }),
            'https://lite-api.jup.ag/': () => new Response('[]', { status: 200 }),
        });
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.ok).toBe(false);
        expect(out.failed).toBe(1);
        expect(h.puts).toEqual([]);
    });

    test('a store failure after a good fetch is recorded as a failure, not thrown', async () => {
        const h = makeHarness([candidate({ source_url: 'https://good.example/a.png' })], { 'https://good.example/': png });
        h.deps.store.put = async () => {
            throw new Error('gcs down');
        };
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.failed).toBe(1);
        expect(h.failures[0]!.error).toContain('gcs down');
        expect(h.successes).toEqual([]);
    });

    test('first-party source URLs are never re-hosted', async () => {
        const h = makeHarness([candidate({ source_url: '/logos/xstocks/TSLAx.png' })], {});
        const out = await syncLogos(h.deps, fastArgs);
        expect(out.skippedFirstParty).toBe(1);
        expect(h.calls).toEqual([]);
    });

    test('no candidates => acknowledged no-op', async () => {
        const h = makeHarness([], {});
        const out = await syncLogos(h.deps, fastArgs);
        expect(out).toMatchObject({ ok: true, processed: 0, skipped: true, reason: 'no_candidates' });
    });

    test('passes the curated universe and windows to the repo', async () => {
        const h = makeHarness([], {}, { curated: [MINT_B] });
        await syncLogos(h.deps, { ...fastArgs, limit: 5, resyncDays: 3, tailDays: 10 });
        const args = h.listArgs[0] as { curatedMints: string[]; limit: number; resyncBeforeMs: number; tailSinceMs: number; publicBaseUrl: string; nowMs: number };
        expect(args.curatedMints).toEqual([MINT_B]);
        expect(args.limit).toBe(5);
        expect(args.nowMs).toBe(NOW);
        expect(args.resyncBeforeMs).toBe(NOW - 3 * DAY);
        expect(args.tailSinceMs).toBe(NOW - 10 * DAY);
        expect(args.publicBaseUrl).toBe(BASE);
    });
});
