import { afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { __setAdvisoriesForTests, annotateAssetAdvisories, getAdvisoriesByMintSync } from '@/lib/advisories';

import { pickPrimaryVariant } from './_asset-helpers';
import { selectMintFromRequest, toCanonicalAsset, toCanonicalVariants } from './_asset-route-loader';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkYtvdQ7BPP3Qz1n';

describe('asset route loader helpers', () => {
    it('builds canonical assets from DB rows', () => {
        const canonical = toCanonicalAsset(
            {
                assetId: 'spacex',
                name: 'SpaceX',
                symbol: 'SPCX',
                category: 'equity',
                aliases: ['spcx'],
                coingeckoId: 'solana',
                updatedAt: 0,
            } as Parameters<typeof toCanonicalAsset>[0],
            toCanonicalVariants([
                {
                    assetId: 'spacex',
                    chain: 'solana',
                    mint: MINT_A,
                    variantId: 'spacex:xstock',
                    kind: 'tokenized_equity',
                    trustTier: 'tier1',
                    stockVariantTier: 'cash_redeemable',
                    tags: ['equity'],
                    createdAt: 0,
                    updatedAt: 0,
                } as Parameters<typeof toCanonicalVariants>[0][number],
            ]),
        );

        expect(canonical.assetId).toBe('spacex');
        expect(canonical.variants.length).toBe(1);
        expect(canonical.variants[0]?.mint).toBe(MINT_A);
        expect(canonical.variants[0]?.stockVariantTier).toBe('cash_redeemable');
    });

    it('selects the requested mint when it belongs to the asset', async () => {
        const request = new Request(`https://api.test/api/v1/assets/solana?mint=${MINT_B}`);
        const canonical = {
            assetId: 'solana',
            category: 'crypto' as const,
            aliases: [],
            variants: [
                { variantId: 'a', mint: MINT_A, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] },
                { variantId: 'b', mint: MINT_B, kind: 'stablecoin' as const, trustTier: 'tier2' as const, tags: [] },
            ],
        };

        const selected = await Effect.runPromise(
            selectMintFromRequest(request, canonical, canonical.variants[0] ?? null),
        );
        expect(selected.selectedMint).toBe(MINT_B);
        expect(selected.selectedVariant.variantId).toBe('b');
    });

    it('selects the path-derived mint when no query mint is provided', async () => {
        const request = new Request('https://api.test/api/v1/assets/solana-some-mint');
        const canonical = {
            assetId: 'solana',
            category: 'crypto' as const,
            aliases: [],
            variants: [
                { variantId: 'a', mint: MINT_A, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] },
                { variantId: 'b', mint: MINT_B, kind: 'stablecoin' as const, trustTier: 'tier2' as const, tags: [] },
            ],
        };

        const selected = await Effect.runPromise(
            selectMintFromRequest(request, canonical, canonical.variants[0] ?? null, { defaultMint: MINT_B }),
        );
        expect(selected.selectedMint).toBe(MINT_B);
        expect(selected.selectedVariant.variantId).toBe('b');
    });

    it('lets query mint override the path-derived mint', async () => {
        const request = new Request(`https://api.test/api/v1/assets/solana-some-mint?mint=${MINT_A}`);
        const canonical = {
            assetId: 'solana',
            category: 'crypto' as const,
            aliases: [],
            variants: [
                { variantId: 'a', mint: MINT_A, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] },
                { variantId: 'b', mint: MINT_B, kind: 'stablecoin' as const, trustTier: 'tier2' as const, tags: [] },
            ],
        };

        const selected = await Effect.runPromise(
            selectMintFromRequest(request, canonical, canonical.variants[0] ?? null, { defaultMint: MINT_B }),
        );
        expect(selected.selectedMint).toBe(MINT_A);
        expect(selected.selectedVariant.variantId).toBe('a');
    });

    it('fails when no primary variant exists', async () => {
        const request = new Request('https://api.test/api/v1/assets/empty');
        const canonical = { assetId: 'empty', category: 'crypto' as const, aliases: [], variants: [] };

        let failed = false;
        try {
            await Effect.runPromise(selectMintFromRequest(request, canonical, null));
        } catch (error) {
            failed = String(error).includes('No primary variant available');
        }
        expect(failed).toBe(true);
    });

    it('returns BadRequestError when required mint is missing', async () => {
        const request = new Request('https://api.test/api/v1/assets/solana');
        const canonical = {
            assetId: 'solana',
            category: 'crypto' as const,
            aliases: [],
            variants: [
                { variantId: 'a', mint: MINT_A, kind: 'native' as const, trustTier: 'tier1' as const, tags: [] },
            ],
        };

        try {
            await Effect.runPromise(
                selectMintFromRequest(request, canonical, canonical.variants[0] ?? null, { requireMint: true }),
            );
            throw new Error('Expected selectMintFromRequest to fail');
        } catch (error) {
            const message = String(error);
            expect(message.includes('BadRequestError')).toBe(true);
            expect(message.includes('`mint` query parameter is required')).toBe(true);
        }
    });
});

describe('asset route loader advisories', () => {
    afterEach(() => {
        __setAdvisoriesForTests(null);
    });

    function canonical() {
        return toCanonicalAsset(
            {
                assetId: 'silver',
                name: 'Silver',
                symbol: 'XAG',
                category: 'commodity',
                aliases: ['xag'],
                updatedAt: 0,
            } as Parameters<typeof toCanonicalAsset>[0],
            toCanonicalVariants([
                {
                    assetId: 'silver',
                    chain: 'solana',
                    mint: MINT_A,
                    variantId: 'silver:silv',
                    kind: 'wrapped',
                    trustTier: 'tier2',
                    tags: [],
                    createdAt: 0,
                    updatedAt: 0,
                },
                {
                    assetId: 'silver',
                    chain: 'solana',
                    mint: MINT_B,
                    variantId: 'silver:ondo',
                    kind: 'wrapped',
                    trustTier: 'tier2',
                    tags: [],
                    createdAt: 0,
                    updatedAt: 0,
                },
            ] as unknown as Parameters<typeof toCanonicalVariants>[0]),
        );
    }

    it('annotates every canonical variant with advisory (null when none)', () => {
        __setAdvisoriesForTests([{ mint: MINT_A, status: 'compromised', reason: 'Issuer exploited', url: null, since: 1 }]);
        const annotated = annotateAssetAdvisories(canonical(), getAdvisoriesByMintSync());
        expect(annotated.variants[0]?.advisory?.status).toBe('compromised');
        expect(annotated.variants[1]?.advisory).toBeNull();
        expect('advisory' in annotated.variants[1]!).toBe(true);
    });

    it('skips the flagged variant for primary and still selects it explicitly without a 404', async () => {
        __setAdvisoriesForTests([{ mint: MINT_A, status: 'compromised', reason: 'Issuer exploited', url: null, since: 1 }]);
        const annotated = annotateAssetAdvisories(canonical(), getAdvisoriesByMintSync());

        const primary = pickPrimaryVariant(annotated, new Map());
        expect(primary?.mint).toBe(MINT_B);

        // Default selection follows the (unflagged) primary.
        const defaulted = await Effect.runPromise(
            selectMintFromRequest(new Request('https://api.test/api/v1/assets/silver'), annotated, primary),
        );
        expect(defaulted.selectedMint).toBe(MINT_B);

        // Explicitly requesting the flagged mint resolves (never NotFound) and carries the advisory.
        const explicit = await Effect.runPromise(
            selectMintFromRequest(new Request(`https://api.test/api/v1/assets/silver?mint=${MINT_A}`), annotated, primary),
        );
        expect(explicit.selectedMint).toBe(MINT_A);
        expect(explicit.selectedVariant.advisory?.status).toBe('compromised');
    });

    it('when every variant is flagged, a primary is still chosen (flagged, with its advisory)', async () => {
        __setAdvisoriesForTests([
            { mint: MINT_A, status: 'compromised', reason: 'a', url: null, since: 1 },
            { mint: MINT_B, status: 'blocked', reason: 'b', url: null, since: 1 },
        ]);
        const annotated = annotateAssetAdvisories(canonical(), getAdvisoriesByMintSync());
        const primary = pickPrimaryVariant(annotated, new Map());
        expect(primary).not.toBeNull();
        expect(primary?.advisory).not.toBeNull();

        const selected = await Effect.runPromise(
            selectMintFromRequest(new Request('https://api.test/api/v1/assets/silver'), annotated, primary),
        );
        expect(selected.selectedVariant.advisory).not.toBeNull();
    });
});
