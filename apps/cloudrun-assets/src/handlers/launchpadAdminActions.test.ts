import { describe, expect, it } from 'bun:test';

import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './assets';
import type { LaunchpadTokenUpsert, StonkfunFetchResult, StonkfunPairsResult, StonkfunToken } from './crons.launchpad';
import type { TokenUpsertFromBirdeye } from './crons.misc';
import {
    adminListLaunchpadPairs,
    adminListLaunchpadTokensForQuote,
    adminPreviewLaunchpadMint,
    adminSyncLaunchpadMint,
    type LaunchpadAdminDeps,
} from './launchpadAdminActions';

const ADMIN = { clerkUserId: 'admin_1' };
const NOW = 1_780_000_000_000;
const GLDX = 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const GP = 'HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ';
const BEER = 'H9rqwhpcv7vFQwQKiGUKY8c5EDj4DdSPDDDvcZCvqdve';

function token(overrides: Partial<StonkfunToken> = {}): StonkfunToken {
    return {
        mint: GP,
        symbol: 'GP',
        name: 'RuneScape Gold',
        imageUrl: null,
        pool: null,
        status: 'graduated',
        mode: 'reward',
        creator: null,
        launchpad: 'launchlab',
        quoteMint: GLDX,
        quoteSymbol: 'GLDX',
        market: {
            priceUsd: 0.003,
            marketCapUsd: 3_800_000,
            fdvUsd: 3_800_000,
            liquidityUsd: 100_000,
            volume24hUsd: 536_000,
            priceChange24h: 1,
        },
        createdAt: NOW - 1_000,
        graduatedAt: NOW - 500,
        links: {},
        raw: {},
        ...overrides,
    };
}

interface Harness {
    deps: LaunchpadAdminDeps;
    calls: string[];
    launchpadUpserts: LaunchpadTokenUpsert[];
    tokenUpserts: TokenUpsertFromBirdeye[];
    marketUpserts: string[];
}

function makeDeps(opts: {
    fetchToken?: StonkfunFetchResult;
    byQuote?: Record<string, StonkfunFetchResult>;
    pairs?: StonkfunPairsResult;
    curated?: string[];
    synced?: Record<string, boolean>;
    approved?: Record<string, { note: string | null; approvedAt: number }>;
    quoteAsset?: { assetId: string; symbol: string | null; name: string | null; imageUrl: string | null } | null;
    knownTokens?: string[];
    withMarket?: string[];
    overview?: Record<string, unknown> | null;
    withIdentity?: boolean;
}): Harness {
    const calls: string[] = [];
    const launchpadUpserts: LaunchpadTokenUpsert[] = [];
    const tokenUpserts: TokenUpsertFromBirdeye[] = [];
    const marketUpserts: string[] = [];
    const deps: LaunchpadAdminDeps = {
        adminAllowlist: { clerkUserIds: new Set(['admin_1']), emails: new Set() },
        stonkfun: {
            async fetchGraduatedTokens() {
                calls.push('fetchGraduatedTokens');
                return { ok: true, items: [] };
            },
            async fetchGraduatedTokensByQuote(quoteMint) {
                calls.push(`byQuote:${quoteMint}`);
                return opts.byQuote?.[quoteMint] ?? { ok: true, items: [] };
            },
            async fetchToken(mint) {
                calls.push(`fetchToken:${mint}`);
                return opts.fetchToken ?? { ok: true, items: [] };
            },
            async fetchPairs() {
                calls.push('fetchPairs');
                return opts.pairs ?? { ok: true, pairs: [] };
            },
        },
        repo: {
            async filterMintsKnownTokens(mints) {
                return mints.filter(m => (opts.knownTokens ?? []).includes(m));
            },
            async filterMintsWithVariantMarket(mints) {
                return mints.filter(m => (opts.withMarket ?? []).includes(m));
            },
            async upsertTokenFromBirdeye(args) {
                tokenUpserts.push(args);
            },
            async upsertLaunchpadTokenLatest(args) {
                launchpadUpserts.push(args);
            },
            async listSyncedStates(_launchpad, mints) {
                calls.push('listSyncedStates');
                const out = new Map<string, { isActive: boolean }>();
                for (const mint of mints) {
                    const state = opts.synced?.[mint];
                    if (state !== undefined) out.set(mint, { isActive: state });
                }
                return out;
            },
            async findApproval(_launchpad, mint) {
                calls.push(`findApproval:${mint}`);
                return opts.approved?.[mint] ?? null;
            },
            async findQuoteAssetByMint() {
                calls.push('findQuoteAssetByMint');
                return opts.quoteAsset === undefined
                    ? { assetId: 'gold', symbol: 'GLD', name: 'Gold', imageUrl: null }
                    : opts.quoteAsset;
            },
        },
        curated: { getAllCuratedMintsInOrder: () => opts.curated ?? [GLDX] },
        ...(opts.withIdentity === false
            ? {}
            : {
                  identity: {
                      birdeye: {
                          async fetchTokenOverview(mint: string) {
                              calls.push(`birdeye:${mint}`);
                              return opts.overview === undefined
                                  ? { symbol: 'BEER', name: 'Beer', decimals: 6, price: 0.01 }
                                  : opts.overview;
                          },
                      },
                      baseRepo: {
                          async upsertVariantMarketFromBirdeye(args: { mint: string }) {
                              marketUpserts.push(args.mint);
                          },
                      },
                  },
              }),
        now: () => NOW,
    };
    return { deps, calls, launchpadUpserts, tokenUpserts, marketUpserts };
}

describe('authz', () => {
    for (const [name, handler, args] of [
        ['adminPreviewLaunchpadMint', adminPreviewLaunchpadMint, { mint: GP }],
        ['adminListLaunchpadTokensForQuote', adminListLaunchpadTokensForQuote, { quoteMints: [GLDX] }],
        ['adminListLaunchpadPairs', adminListLaunchpadPairs, {}],
        ['adminSyncLaunchpadMint', adminSyncLaunchpadMint, { mint: GP }],
    ] as const) {
        it(`${name} requires an identity and an admin`, async () => {
            const { deps, calls } = makeDeps({});
            await expect(handler(deps, args, null)).rejects.toBeInstanceOf(IdentityRequiredError);
            await expect(handler(deps, args, { clerkUserId: 'nope' })).rejects.toBeInstanceOf(UnauthorizedError);
            expect(calls).toHaveLength(0);
        });
    }
});

describe('adminPreviewLaunchpadMint', () => {
    it('rejects a bad mint without calling the provider', async () => {
        const { deps, calls } = makeDeps({});
        await expect(adminPreviewLaunchpadMint(deps, { mint: 'nope' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(adminPreviewLaunchpadMint(deps, {}, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        expect(calls).toHaveLength(0);
    });

    it('reports found=false with a warning when stonk.fun does not know the mint', async () => {
        const { deps } = makeDeps({ fetchToken: { ok: true, items: [] } });
        const preview = await adminPreviewLaunchpadMint(deps, { mint: GP }, ADMIN);
        expect(preview).toMatchObject({
            mint: GP,
            found: false,
            token: null,
            quote: null,
            synced: false,
            approved: null,
        });
        expect(preview.warnings[0]).toContain('does not know');
    });

    it('turns provider failures into InvalidArgsError so the dialog can show them', async () => {
        const { deps } = makeDeps({ fetchToken: { ok: false, reason: 'http_error', status: 503 } });
        await expect(adminPreviewLaunchpadMint(deps, { mint: GP }, ADMIN)).rejects.toThrow('HTTP 503');
    });

    it('builds the full preview for a live, curated, above-threshold coin', async () => {
        const { deps } = makeDeps({
            fetchToken: { ok: true, items: [token()] },
            synced: { [GP]: true },
            approved: { [GP]: { note: 'team pick', approvedAt: NOW - 10 } },
        });
        const preview = await adminPreviewLaunchpadMint(deps, { mint: GP }, ADMIN);
        expect(preview.found).toBe(true);
        expect(preview.token?.symbol).toBe('GP');
        expect(preview.quote).toEqual({
            mint: GLDX,
            symbol: 'GLDX',
            curated: true,
            asset: { assetId: 'gold', symbol: 'GLD', name: 'Gold', imageUrl: null },
        });
        expect(preview).toMatchObject({ synced: true, isActive: true, meetsThreshold: true });
        expect(preview.approved).toEqual({ note: 'team pick', approvedAt: NOW - 10 });
        expect(preview.warnings).toEqual(['Already approved; approving again only updates the note.']);
    });

    it('warns about non-curated quote, sub-threshold, not graduated, and pending identity', async () => {
        const { deps } = makeDeps({
            fetchToken: {
                ok: true,
                items: [
                    token({
                        mint: BEER,
                        quoteMint: BONK,
                        quoteSymbol: 'BONK',
                        status: 'bonding',
                        market: { ...token().market, marketCapUsd: 100, volume24hUsd: 5 },
                    }),
                ],
            },
            synced: { [BEER]: false },
        });
        const preview = await adminPreviewLaunchpadMint(deps, { mint: BEER }, ADMIN);
        expect(preview.quote?.curated).toBe(false);
        expect(preview.quote?.asset).toBeNull();
        expect(preview.meetsThreshold).toBe(false);
        expect(preview.warnings.join('\n')).toContain('Not graduated');
        expect(preview.warnings.join('\n')).toContain('not a curated asset');
        expect(preview.warnings.join('\n')).toContain('Below the sync threshold');
        expect(preview.warnings.join('\n')).toContain('not live yet');
    });
});

describe('adminListLaunchpadTokensForQuote', () => {
    it('validates quoteMints', async () => {
        const { deps, calls } = makeDeps({});
        for (const bad of [
            {},
            { quoteMints: [] },
            { quoteMints: ['x'] },
            { quoteMints: 'x' },
            { quoteMints: [GLDX], maxPages: 'a' },
        ]) {
            await expect(adminListLaunchpadTokensForQuote(deps, bad, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        }
        expect(calls).toHaveLength(0);
    });

    it('merges pages per quote mint, dedupes, sorts by market cap, and flags each coin', async () => {
        const { deps, calls } = makeDeps({
            byQuote: {
                [GLDX]: {
                    ok: true,
                    items: [
                        token({
                            mint: BEER,
                            symbol: 'BEER',
                            market: { ...token().market, marketCapUsd: 12_000, volume24hUsd: 4_000 },
                        }),
                        token(),
                        token({ mint: GP }), // duplicate
                        token({ mint: BONK, quoteMint: BONK }), // wrong quote; ignored
                    ],
                },
            },
            synced: { [GP]: true },
            approved: { [GP]: { note: null, approvedAt: NOW - 1 } },
        });
        const result = await adminListLaunchpadTokensForQuote(deps, { quoteMints: [GLDX, GLDX] }, ADMIN);
        expect(calls.filter(c => c.startsWith('byQuote:'))).toEqual([`byQuote:${GLDX}`]);
        expect(result.quoteMints).toEqual([GLDX]);
        expect(result.tokens.map(t => t.symbol)).toEqual(['GP', 'BEER']);
        expect(result.tokens[0]).toMatchObject({ synced: true, isActive: true, meetsThreshold: true });
        expect(result.tokens[0]!.approved).toEqual({ note: null, approvedAt: NOW - 1 });
        expect(result.tokens[1]).toMatchObject({
            synced: false,
            isActive: false,
            approved: null,
            meetsThreshold: false,
        });
    });

    it('surfaces provider failures as InvalidArgsError', async () => {
        const { deps } = makeDeps({ byQuote: { [GLDX]: { ok: false, reason: 'invalid_payload' } } });
        await expect(adminListLaunchpadTokensForQuote(deps, { quoteMints: [GLDX] }, ADMIN)).rejects.toThrow(
            'unexpected payload',
        );
    });
});

describe('adminListLaunchpadPairs', () => {
    it('keeps only launchable pairs that are curated mints and groups them by canonical asset', async () => {
        const { deps } = makeDeps({
            pairs: {
                ok: true,
                pairs: [
                    {
                        mint: GLDX,
                        symbol: 'GLDX',
                        name: 'Gold xStock',
                        category: 'xstock',
                        logoUrl: null,
                        launchable: true,
                    },
                    { mint: BONK, symbol: 'BONK', name: 'Bonk', category: 'custom', logoUrl: null, launchable: true },
                    { mint: BEER, symbol: 'X', name: null, category: 'custom', logoUrl: null, launchable: false },
                ],
            },
            curated: [GLDX, BEER],
        });
        const result = await adminListLaunchpadPairs(deps, {}, ADMIN);
        expect(result).toMatchObject({ pairsTotal: 3, curatedPairs: 1 });
        expect(result.assets).toEqual([
            {
                assetId: 'gold',
                symbol: 'GLD',
                name: 'Gold',
                imageUrl: expect.any(String),
                quoteMints: [{ mint: GLDX, symbol: 'GLDX', category: 'xstock' }],
            },
        ]);
    });

    it('surfaces provider failures', async () => {
        const { deps } = makeDeps({ pairs: { ok: false, reason: 'http_error', status: 502 } });
        await expect(adminListLaunchpadPairs(deps, {}, ADMIN)).rejects.toThrow('HTTP 502');
    });
});

describe('adminSyncLaunchpadMint', () => {
    it('fetches identity from Birdeye for a new coin and stores an active row', async () => {
        const h = makeDeps({ fetchToken: { ok: true, items: [token({ mint: BEER })] } });
        const result = await adminSyncLaunchpadMint(h.deps, { mint: BEER }, ADMIN);
        expect(result).toEqual({ mint: BEER, synced: true, isActive: true, reason: null });
        expect(h.calls).toContain(`birdeye:${BEER}`);
        expect(h.tokenUpserts.map(t => t.address)).toEqual([BEER]);
        expect(h.marketUpserts).toEqual([BEER]);
        expect(h.launchpadUpserts[0]).toMatchObject({
            mint: BEER,
            quoteMint: GLDX,
            isActive: true,
            sourceRank: 1_000_000,
        });
    });

    it('skips Birdeye when identity already exists', async () => {
        const h = makeDeps({ fetchToken: { ok: true, items: [token()] }, knownTokens: [GP], withMarket: [GP] });
        const result = await adminSyncLaunchpadMint(h.deps, { mint: GP }, ADMIN);
        expect(result.isActive).toBe(true);
        expect(h.calls.some(c => c.startsWith('birdeye:'))).toBe(false);
    });

    it('stores an inactive row when Birdeye has no identity, and refuses ungraduated / non-curated coins', async () => {
        const noIdentity = makeDeps({ fetchToken: { ok: true, items: [token({ mint: BEER })] }, overview: null });
        expect(await adminSyncLaunchpadMint(noIdentity.deps, { mint: BEER }, ADMIN)).toMatchObject({
            synced: true,
            isActive: false,
            reason: 'identity_pending',
        });
        expect(noIdentity.launchpadUpserts[0]!.isActive).toBe(false);

        const bonding = makeDeps({ fetchToken: { ok: true, items: [token({ status: 'bonding' })] } });
        expect(await adminSyncLaunchpadMint(bonding.deps, { mint: GP }, ADMIN)).toMatchObject({
            synced: false,
            reason: 'not_graduated',
        });
        expect(bonding.launchpadUpserts).toHaveLength(0);

        const foreign = makeDeps({ fetchToken: { ok: true, items: [token({ quoteMint: BONK })] } });
        expect(await adminSyncLaunchpadMint(foreign.deps, { mint: GP }, ADMIN)).toMatchObject({
            reason: 'quote_not_curated',
        });

        const missing = makeDeps({ fetchToken: { ok: true, items: [] } });
        expect(await adminSyncLaunchpadMint(missing.deps, { mint: GP }, ADMIN)).toMatchObject({
            synced: false,
            reason: 'not_found',
        });
    });
});
