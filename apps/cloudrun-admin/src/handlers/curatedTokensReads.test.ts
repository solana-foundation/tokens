import { describe, expect, it } from 'bun:test';

import {
    getCanonicalEditor,
    getVariantEditor,
    listCanonicalAssets,
    listVariantsByAssetIds,
    previewMint,
    searchCanonicalAssets,
    type AdminReadsDeps,
    type AdminReadsRepo,
    type AssetRow,
    type VariantWithMarketRow,
} from './curatedTokensReads';
import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';

const ADMIN = { clerkUserId: 'admin_1' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function asset(overrides: Partial<AssetRow> = {}): AssetRow {
    return {
        assetId: 'bitcoin',
        category: 'crypto',
        name: 'Bitcoin',
        symbol: 'BTC',
        coingeckoId: 'bitcoin-cg',
        description: null,
        imageUrl: null,
        isActive: true,
        ...overrides,
    };
}

function variant(overrides: Partial<VariantWithMarketRow> = {}): VariantWithMarketRow {
    return {
        assetId: 'bitcoin',
        mint: MINT_A,
        variantId: 'bitcoin:wbtc',
        kind: 'wrapped',
        trustTier: 'tier1',
        tags: ['wrapped'],
        label: null,
        issuer: null,
        issuerUrl: null,
        stockVariantTier: null,
        isActive: true,
        market: null,
        advisory: null,
        pegHealth: null,
        structuralHealth: null,
        ...overrides,
    };
}

const PEG_HEALTH = {
    provider: 'tokens' as const,
    tier: 'warning' as const,
    deviationPct: -2.4,
    ok: true,
    errorMessage: null,
    updatedAt: 1_750_000_000_000,
};
const STRUCTURAL_HEALTH = { grade: 'B+' as const, updatedAt: 1_749_000_000_000 };

interface FakeState {
    assets?: AssetRow[];
    variants?: VariantWithMarketRow[];
    customAliases?: Array<{ assetId: string; alias: string }>;
    members?: Array<{ slug: 'majors' | 'currencies' | 'rwas' | 'etfs' | 'metals' | 'stocks'; assetId: string }>;
    markets?: Record<
        string,
        {
            symbol: string | null;
            name: string | null;
            logoURI: string | null;
            liquidity: number | null;
            lastFetchedAt: number | null;
        }
    >;
}

function makeRepo(state: FakeState = {}): { repo: AdminReadsRepo; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const track = (name: string, args: unknown) => {
        (calls[name] ??= []).push(args);
    };
    const repo: AdminReadsRepo = {
        listAssets: async args => {
            track('listAssets', args);
            const assets = state.assets ?? [];
            return args.includeInactive ? assets : assets.filter(a => a.isActive);
        },
        listAllVariantsWithMarkets: async () => state.variants ?? [],
        listVariantsWithMarketsByAssetIds: async assetIds => {
            track('listVariantsWithMarketsByAssetIds', assetIds);
            return (state.variants ?? []).filter(v => assetIds.includes(v.assetId));
        },
        listCustomAliases: async () => state.customAliases ?? [],
        listCustomAliasesByAssetId: async assetId =>
            (state.customAliases ?? []).filter(a => a.assetId === assetId).map(a => a.alias),
        listCollectionMembers: async () => state.members ?? [],
        getAssetByAssetId: async assetId => (state.assets ?? []).find(a => a.assetId === assetId) ?? null,
        getVariantByMint: async mint => (state.variants ?? []).find(v => v.mint === mint) ?? null,
        getMarketByMint: async mint => state.markets?.[mint] ?? null,
        searchAssets: async args => {
            track('searchAssets', args);
            return (state.assets ?? []).map(a => ({
                assetId: a.assetId,
                name: a.name,
                symbol: a.symbol,
                category: a.category,
            }));
        },
    };
    return { repo, calls };
}

function makeDeps(state: FakeState = {}): { deps: AdminReadsDeps; calls: Record<string, unknown[]> } {
    const { repo, calls } = makeRepo(state);
    return { deps: { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() } }, calls };
}

describe('authz (reads)', () => {
    const handlers: Array<
        [
            string,
            (deps: AdminReadsDeps, args: unknown, identity: { clerkUserId: string } | null) => Promise<unknown>,
            unknown,
        ]
    > = [
        ['listCanonicalAssets', listCanonicalAssets, {}],
        ['listVariantsByAssetIds', listVariantsByAssetIds, { assetIds: ['bitcoin'] }],
        ['getCanonicalEditor', getCanonicalEditor, { assetId: 'bitcoin' }],
        ['getVariantEditor', getVariantEditor, { mint: MINT_A }],
        ['searchCanonicalAssets', searchCanonicalAssets, { query: 'btc' }],
        ['previewMint', previewMint, { mint: MINT_A }],
    ];

    for (const [name, handler, args] of handlers) {
        it(`${name} rejects missing identity and non-admin callers`, async () => {
            const { deps } = makeDeps();
            await expect(handler(deps, args, null)).rejects.toBeInstanceOf(IdentityRequiredError);
            await expect(handler(deps, args, { clerkUserId: 'user_9' })).rejects.toBeInstanceOf(UnauthorizedError);
        });
    }
});

describe('listCanonicalAssets', () => {
    it('returns the Convex row shape with best-variant selection, searchHints and logo resolution', async () => {
        const { deps } = makeDeps({
            assets: [asset()],
            variants: [
                variant({
                    mint: MINT_A,
                    variantId: 'bitcoin:wbtc',
                    label: 'WBTC',
                    market: {
                        symbol: 'WBTC',
                        name: 'Wrapped BTC',
                        logoURI: 'https://img/wbtc.png',
                        liquidity: 100,
                        lastFetchedAt: 111,
                    },
                }),
                variant({
                    mint: MINT_B,
                    variantId: 'bitcoin:cbbtc',
                    market: {
                        symbol: 'cbBTC',
                        name: 'Coinbase BTC',
                        logoURI: 'https://img/cbbtc.png',
                        liquidity: 900,
                        lastFetchedAt: 222,
                    },
                }),
            ],
            customAliases: [{ assetId: 'bitcoin', alias: 'digital gold' }],
            members: [
                { slug: 'currencies', assetId: 'bitcoin' },
                { slug: 'majors', assetId: 'bitcoin' },
            ],
        });

        const rows = await listCanonicalAssets(deps, {}, ADMIN);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        // Best variant = highest liquidity active variant (MINT_B).
        expect(row.representativeMint).toBe(MINT_B);
        expect(row.lastFetchedAt).toBe(222);
        // No asset imageUrl, but 'bitcoin' has a static override — override wins over variant logo.
        expect(row.imageUrl).toBe('/logos/popular/bitcoin.png');
        // Collections are ordered by canonical slug order (majors before currencies).
        expect(row.collections).toEqual(['majors', 'currencies']);
        expect(row.variantCount).toBe(2);
        expect(row.searchHints).toEqual([
            'bitcoin',
            'Bitcoin',
            'BTC',
            'bitcoin-cg',
            'digital gold',
            MINT_B,
            'bitcoin:cbbtc',
            'cbBTC',
            'Coinbase BTC',
            MINT_A,
            'bitcoin:wbtc',
            'WBTC',
            'Wrapped BTC',
        ]);
        expect(row).toEqual({
            assetId: 'bitcoin',
            category: 'crypto',
            name: 'Bitcoin',
            symbol: 'BTC',
            imageUrl: '/logos/popular/bitcoin.png',
            isActive: true,
            variantCount: 2,
            collections: ['majors', 'currencies'],
            representativeMint: MINT_B,
            lastFetchedAt: 222,
            searchHints: row.searchHints,
        });
    });

    it('omits optional keys and falls back to em-dash for blank name/symbol', async () => {
        const { deps } = makeDeps({
            assets: [asset({ assetId: 'mystery', name: '  ', symbol: null, coingeckoId: null })],
        });
        const rows = await listCanonicalAssets(deps, {}, ADMIN);
        const row = rows[0]!;
        expect(row.name).toBe('—');
        expect(row.symbol).toBe('—');
        expect('imageUrl' in row).toBe(false);
        expect('representativeMint' in row).toBe(false);
        expect('lastFetchedAt' in row).toBe(false);
        expect(row.collections).toEqual([]);
        expect(row.searchHints).toEqual(['mystery']);
    });

    it('prefers asset imageUrl over override and variant logos', async () => {
        const { deps } = makeDeps({
            assets: [asset({ imageUrl: ' https://img/custom.png ' })],
            variants: [
                variant({
                    market: {
                        symbol: null,
                        name: null,
                        logoURI: 'https://img/v.png',
                        liquidity: 1,
                        lastFetchedAt: null,
                    },
                }),
            ],
        });
        const rows = await listCanonicalAssets(deps, {}, ADMIN);
        expect(rows[0]!.imageUrl).toBe('https://img/custom.png');
    });

    it('uses the best variant logo when there is no imageUrl or override', async () => {
        const { deps } = makeDeps({
            assets: [asset({ assetId: 'random-token', name: 'Random', symbol: 'RND' })],
            variants: [
                variant({
                    assetId: 'random-token',
                    market: {
                        symbol: null,
                        name: null,
                        logoURI: 'https://img/v.png',
                        liquidity: 1,
                        lastFetchedAt: null,
                    },
                }),
            ],
        });
        const rows = await listCanonicalAssets(deps, {}, ADMIN);
        expect(rows[0]!.imageUrl).toBe('https://img/v.png');
    });

    it('defaults includeInactive to true and forwards the flag', async () => {
        const { deps, calls } = makeDeps({ assets: [] });
        await listCanonicalAssets(deps, {}, ADMIN);
        await listCanonicalAssets(deps, { includeInactive: false }, ADMIN);
        expect(calls.listAssets?.[0]).toEqual({ includeInactive: true, limit: 2500 });
        expect(calls.listAssets?.[1]).toEqual({ includeInactive: false, limit: 2500 });
    });

    it('inactive variants rank below active ones regardless of liquidity', async () => {
        const { deps } = makeDeps({
            assets: [asset()],
            variants: [
                variant({
                    mint: MINT_A,
                    isActive: false,
                    market: { symbol: null, name: null, logoURI: null, liquidity: 9999, lastFetchedAt: 1 },
                }),
                variant({
                    mint: MINT_B,
                    variantId: 'bitcoin:b',
                    isActive: true,
                    market: { symbol: null, name: null, logoURI: null, liquidity: 1, lastFetchedAt: 2 },
                }),
            ],
        });
        const rows = await listCanonicalAssets(deps, {}, ADMIN);
        expect(rows[0]!.representativeMint).toBe(MINT_B);
    });
});

describe('listVariantsByAssetIds', () => {
    it('classifies liquidity tiers, sorts rows, and omits absent optionals', async () => {
        const { deps } = makeDeps({
            variants: [
                variant({
                    mint: MINT_A,
                    variantId: 'bitcoin:small',
                    trustTier: 'experimental',
                    market: { symbol: 'SMALL', name: 'Small', logoURI: null, liquidity: 5, lastFetchedAt: null },
                }),
                variant({
                    mint: MINT_B,
                    variantId: 'bitcoin:big',
                    label: 'Big',
                    issuer: 'Issuer Inc',
                    issuerUrl: 'https://issuer.example',
                    stockVariantTier: 'share_redeemable',
                    market: {
                        symbol: 'BIG',
                        name: 'Big BTC',
                        logoURI: 'https://img/big.png',
                        liquidity: 20_000_000,
                        lastFetchedAt: 42,
                    },
                }),
            ],
        });

        const result = await listVariantsByAssetIds(deps, { assetIds: [' bitcoin ', 'bitcoin', ''] }, ADMIN);
        expect(result).toHaveLength(1);
        expect(result[0]!.assetId).toBe('bitcoin');
        const [big, small] = result[0]!.variants;
        expect(big).toEqual({
            assetId: 'bitcoin',
            mint: MINT_B,
            variantId: 'bitcoin:big',
            kind: 'wrapped',
            liquidityTier: 'tier1',
            trustTier: 'tier1',
            storedTrustTier: 'tier1',
            tags: ['wrapped'],
            label: 'Big',
            issuer: 'Issuer Inc',
            issuerUrl: 'https://issuer.example',
            stockVariantTier: 'share_redeemable',
            symbol: 'BIG',
            name: 'Big BTC',
            logoURI: 'https://img/big.png',
            isActive: true,
            lastFetchedAt: 42,
            advisory: null,
            pegHealth: null,
            structuralHealth: null,
        });
        expect(small!.liquidityTier).toBe('tier3');
        expect(small!.trustTier).toBe('tier3'); // trustTier mirrors liquidityTier
        expect(small!.storedTrustTier).toBe('experimental');
        expect('lastFetchedAt' in small!).toBe(false);
        expect('logoURI' in small!).toBe(false);
        expect('label' in small!).toBe(false);
    });

    it('carries advisory source, pegHealth and structuralHealth through to the editor rows', async () => {
        const advisory = {
            status: 'caution' as const,
            reason: 'Trading 2.40% below peg',
            url: null,
            since: 1_700_000_000_000,
            source: 'webacy_depeg' as const,
        };
        const { deps } = makeDeps({
            variants: [
                variant({ mint: MINT_A, advisory, pegHealth: PEG_HEALTH, structuralHealth: STRUCTURAL_HEALTH }),
                variant({ mint: MINT_B, variantId: 'bitcoin:plain' }),
            ],
        });
        const result = await listVariantsByAssetIds(deps, { assetIds: ['bitcoin'] }, ADMIN);
        const rows = result[0]!.variants;
        const monitored = rows.find(row => row.mint === MINT_A)!;
        const plain = rows.find(row => row.mint === MINT_B)!;
        expect(monitored.advisory).toEqual(advisory);
        expect(monitored.pegHealth).toEqual(PEG_HEALTH);
        expect(monitored.structuralHealth).toEqual(STRUCTURAL_HEALTH);
        // Always present (null, never omitted) so the UI can treat undefined as "old server build".
        expect(plain.advisory).toBeNull();
        expect(plain.pegHealth).toBeNull();
        expect(plain.structuralHealth).toBeNull();
        expect('pegHealth' in plain && 'structuralHealth' in plain).toBe(true);
    });

    it('returns an empty array without hitting the repo when no ids survive normalization', async () => {
        const { deps, calls } = makeDeps();
        expect(await listVariantsByAssetIds(deps, { assetIds: ['', '  '] }, ADMIN)).toEqual([]);
        expect(calls.listVariantsWithMarketsByAssetIds).toBeUndefined();
    });

    it('caps the batch at 100 asset ids', async () => {
        const { deps, calls } = makeDeps();
        const assetIds = Array.from({ length: 150 }, (_, i) => `asset-${i}`);
        const result = await listVariantsByAssetIds(deps, { assetIds }, ADMIN);
        expect(result).toHaveLength(100);
        expect((calls.listVariantsWithMarketsByAssetIds?.[0] as string[]).length).toBe(100);
    });

    it('rejects non-array assetIds', async () => {
        const { deps } = makeDeps();
        await expect(listVariantsByAssetIds(deps, { assetIds: 'bitcoin' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });
});

describe('getCanonicalEditor', () => {
    it('returns null for blank/unknown asset ids', async () => {
        const { deps } = makeDeps();
        expect(await getCanonicalEditor(deps, { assetId: '  ' }, ADMIN)).toBeNull();
        expect(await getCanonicalEditor(deps, { assetId: 'ghost' }, ADMIN)).toBeNull();
    });

    it('resolves logo state, fallback fields, aliases and collections (Convex shape)', async () => {
        const { deps } = makeDeps({
            assets: [asset({ imageUrl: null })],
            variants: [
                variant({
                    market: {
                        symbol: 'WBTC',
                        name: 'Wrapped',
                        logoURI: 'https://img/v.png',
                        liquidity: 10,
                        lastFetchedAt: 5,
                    },
                }),
            ],
            customAliases: [{ assetId: 'bitcoin', alias: 'digital gold' }],
            members: [{ slug: 'majors', assetId: 'bitcoin' }],
        });
        const result = await getCanonicalEditor(deps, { assetId: 'bitcoin' }, ADMIN);
        expect(result).toEqual({
            asset: {
                assetId: 'bitcoin',
                category: 'crypto',
                name: 'Bitcoin',
                symbol: 'BTC',
                coingeckoId: 'bitcoin-cg',
                resolvedImageUrl: '/logos/popular/bitcoin.png',
                logoSource: 'override',
                fallbackImageUrl: '/logos/popular/bitcoin.png',
                fallbackLogoSource: 'override',
                isActive: true,
            },
            aliases: ['digital gold'],
            collections: ['majors'],
        });
    });

    it('falls back to the best-variant logo when there is no override', async () => {
        const { deps } = makeDeps({
            assets: [asset({ assetId: 'random-token', name: 'Random', symbol: 'RND', coingeckoId: null })],
            variants: [
                variant({
                    assetId: 'random-token',
                    market: {
                        symbol: null,
                        name: null,
                        logoURI: 'https://img/v.png',
                        liquidity: 1,
                        lastFetchedAt: null,
                    },
                }),
            ],
        });
        const result = await getCanonicalEditor(deps, { assetId: 'random-token' }, ADMIN);
        expect(result?.asset.logoSource).toBe('variant');
        expect(result?.asset.resolvedImageUrl).toBe('https://img/v.png');
        expect(result?.asset.fallbackImageUrl).toBe('https://img/v.png');
        expect(result?.asset.fallbackLogoSource).toBe('variant');
    });

    it("reports 'url' with an 'override'/'variant'/'none' fallback when imageUrl is set", async () => {
        const { deps } = makeDeps({
            assets: [
                asset({
                    assetId: 'random-token',
                    name: 'Random',
                    symbol: 'RND',
                    coingeckoId: null,
                    imageUrl: 'https://img/a.png',
                    description: 'desc',
                }),
            ],
        });
        const result = await getCanonicalEditor(deps, { assetId: 'random-token' }, ADMIN);
        expect(result?.asset.imageUrl).toBe('https://img/a.png');
        expect(result?.asset.resolvedImageUrl).toBe('https://img/a.png');
        expect(result?.asset.logoSource).toBe('url');
        expect(result?.asset.fallbackLogoSource).toBe('none');
        expect(result?.asset.description).toBe('desc');
        expect(result && 'fallbackImageUrl' in result.asset).toBe(false);
    });
});

describe('getVariantEditor', () => {
    it('returns null for unknown mints', async () => {
        const { deps } = makeDeps();
        expect(await getVariantEditor(deps, { mint: MINT_A }, ADMIN)).toBeNull();
    });

    it('returns variant + canonical + market with omitted optionals', async () => {
        const { deps } = makeDeps({
            assets: [asset()],
            variants: [
                variant({
                    label: 'WBTC',
                    market: { symbol: 'WBTC', name: null, logoURI: null, liquidity: null, lastFetchedAt: null },
                }),
            ],
        });
        const result = await getVariantEditor(deps, { mint: MINT_A }, ADMIN);
        expect(result).toEqual({
            variant: {
                assetId: 'bitcoin',
                mint: MINT_A,
                variantId: 'bitcoin:wbtc',
                kind: 'wrapped',
                trustTier: 'tier1',
                tags: ['wrapped'],
                label: 'WBTC',
                isActive: true,
                advisory: null,
                pegHealth: null,
                structuralHealth: null,
            },
            canonical: { assetId: 'bitcoin', name: 'Bitcoin', symbol: 'BTC' },
            market: { symbol: 'WBTC' },
        });
    });

    it('carries the active advisory through to the editor row', async () => {
        const advisory = {
            status: 'compromised' as const,
            reason: 'Treasury exploited',
            url: 'https://x.test/p',
            since: 1_700_000_000_000,
        };
        const { deps } = makeDeps({ assets: [asset()], variants: [variant({ advisory })] });
        const result = await getVariantEditor(deps, { mint: MINT_A }, ADMIN);
        expect(result?.variant.advisory).toEqual(advisory);
    });

    it('returns market: null when there is no market row', async () => {
        const { deps } = makeDeps({ assets: [asset()], variants: [variant({ market: null })] });
        const result = await getVariantEditor(deps, { mint: MINT_A }, ADMIN);
        expect(result?.market).toBeNull();
    });

    it('carries pegHealth and structuralHealth through to the editor row', async () => {
        const { deps } = makeDeps({
            assets: [asset()],
            variants: [variant({ pegHealth: PEG_HEALTH, structuralHealth: STRUCTURAL_HEALTH })],
        });
        const result = await getVariantEditor(deps, { mint: MINT_A }, ADMIN);
        expect(result?.variant.pegHealth).toEqual(PEG_HEALTH);
        expect(result?.variant.structuralHealth).toEqual(STRUCTURAL_HEALTH);
    });
});

describe('searchCanonicalAssets', () => {
    it('lowercases the query, clamps the limit, and omits null name/symbol', async () => {
        const { deps, calls } = makeDeps({ assets: [asset({ name: null, symbol: null })] });
        const rows = await searchCanonicalAssets(deps, { query: '  BiTcOiN ', limit: 5000 }, ADMIN);
        expect(calls.searchAssets?.[0]).toEqual({ query: 'bitcoin', limit: 100, scanLimit: 2500 });
        expect(rows).toEqual([{ assetId: 'bitcoin', category: 'crypto' }]);
    });

    it('defaults the limit to 25 and floors it at 1', async () => {
        const { deps, calls } = makeDeps();
        await searchCanonicalAssets(deps, { query: '' }, ADMIN);
        await searchCanonicalAssets(deps, { query: '', limit: 0 }, ADMIN);
        expect((calls.searchAssets?.[0] as { limit: number }).limit).toBe(25);
        expect((calls.searchAssets?.[1] as { limit: number }).limit).toBe(1);
    });
});

describe('previewMint', () => {
    it('returns null for invalid mint addresses', async () => {
        const { deps } = makeDeps();
        expect(await previewMint(deps, { mint: 'not-a-mint' }, ADMIN)).toBeNull();
        expect(await previewMint(deps, { mint: '' }, ADMIN)).toBeNull();
    });

    it('suggests solana-<mint> when the mint is unknown and reports market presence', async () => {
        const { deps } = makeDeps({
            markets: {
                [MINT_A]: {
                    symbol: 'NEW',
                    name: 'New Token',
                    logoURI: 'https://img/new.png',
                    liquidity: 1,
                    lastFetchedAt: 77,
                },
            },
        });
        expect(await previewMint(deps, { mint: MINT_A }, ADMIN)).toEqual({
            exists: false,
            assetId: `solana-${MINT_A}`,
            name: 'New Token',
            symbol: 'NEW',
            imageUrl: 'https://img/new.png',
            hasMarketData: true,
            lastFetchedAt: 77,
        });
    });

    it('reports the owning asset when the mint already has a variant', async () => {
        const { deps } = makeDeps({ assets: [asset()], variants: [variant({ market: null })] });
        expect(await previewMint(deps, { mint: MINT_A }, ADMIN)).toEqual({
            exists: true,
            assetId: 'bitcoin',
            category: 'crypto',
            name: 'Bitcoin',
            symbol: 'BTC',
            hasMarketData: false,
        });
    });
});
