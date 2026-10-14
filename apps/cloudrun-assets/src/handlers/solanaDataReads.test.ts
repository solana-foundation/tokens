import { describe, expect, it } from 'bun:test';

import {
    getByMint,
    listAssets,
    parseSolanaDataGetByMintArgs,
    parseSolanaDataListArgs,
    rowToSolanaDataAssetDetailResult,
    type SolanaDataAssetDetailRow,
    type SolanaDataAssetReadRow,
    type SolanaDataReadsRepo,
} from './solanaDataReads';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function pageRow(overrides: Partial<SolanaDataAssetReadRow> = {}): SolanaDataAssetReadRow {
    return {
        mint: USDC,
        symbol: 'USDC',
        name: 'USD Coin',
        logo_uri: 'https://img/usdc.png',
        logo_cdn_url: null,
        has_token_page: true,
        asset_id: 'usd',
        group_name: 'Stablecoins',
        category: 'Fiat-Backed',
        asset_class: 'USD Stablecoins',
        allium_asset_class: 'stablecoins',
        rwa_asset_class: 'Stablecoins',
        allium_asset_value_usd: 6_686_697_914.43,
        rwa_asset_value_usd: 6_617_043_551.63,
        coingecko_market_cap_usd: 72_677_006_928.25,
        source_rank: 0,
        total: 3293,
        meta_last_synced_at: 1_791_926_904_939,
        meta_source_generated_at: '2026-10-13T18:54:28.395Z',
        ...overrides,
    };
}

function detailRow(overrides: Partial<SolanaDataAssetDetailRow> = {}): SolanaDataAssetDetailRow {
    const page: Partial<SolanaDataAssetReadRow> = { ...pageRow() };
    delete page.total;
    delete page.meta_last_synced_at;
    delete page.meta_source_generated_at;
    return {
        ...(page as Omit<SolanaDataAssetReadRow, 'total' | 'meta_last_synced_at' | 'meta_source_generated_at'>),
        raw_json: JSON.stringify({
            token: 'USDC',
            mint_address: USDC,
            group: 'Stablecoins',
            coingecko_market_cap: '7.2677E10',
        }),
        source_generated_at: new Date('2026-10-13T18:54:28.395Z'),
        last_synced_at: 1_791_926_904_939,
        provider_name: null,
        provider_logo_uri: null,
        provider_fetched_at: 1_791_926_000_000,
        ...overrides,
    };
}

function repoWith(rows: SolanaDataAssetReadRow[], detail: SolanaDataAssetDetailRow | null): SolanaDataReadsRepo {
    return {
        async listActive() {
            return rows;
        },
        async findActiveByMint(mint) {
            return detail && detail.mint === mint ? detail : null;
        },
    };
}

describe('parseSolanaDataListArgs', () => {
    it('clamps limit/offset, trims filters, accepts class or assetClass', () => {
        expect(parseSolanaDataListArgs({})).toEqual({ limit: 500, offset: 0 });
        expect(parseSolanaDataListArgs({ limit: 99_999, offset: -3, group: ' RWA ', class: 'Stocks' })).toEqual({
            limit: 5000,
            offset: 0,
            group: 'RWA',
            assetClass: 'Stocks',
        });
        expect(() => parseSolanaDataListArgs({ limit: 'x' })).toThrow();
        expect(() => parseSolanaDataListArgs({ group: 'g'.repeat(81) })).toThrow();
    });
});

describe('listAssets', () => {
    it('maps rows, prefers the first-party logo, and reads meta from the first row', async () => {
        const rows = [
            pageRow({ logo_cdn_url: 'https://cdn/usdc.webp' }),
            pageRow({ mint: BONK, symbol: 'BONK', source_rank: 1 }),
        ];
        const result = await listAssets(repoWith(rows, null), { limit: 2 });
        expect(result.total).toBe(3293);
        expect(result.generatedAt).toBe('2026-10-13T18:54:28.395Z');
        expect(result.syncedAt).toBe(1_791_926_904_939);
        expect(result.items.map(i => i.mint)).toEqual([USDC, BONK]);
        expect(result.items[0]!.logoURI).toBe('https://cdn/usdc.webp');
        expect(result.items[0]!.rank).toBe(0);
    });

    it('keeps total from a meta-only row when the page is empty', async () => {
        const metaOnly = pageRow({
            mint: null,
            symbol: null,
            source_rank: null,
            name: null,
            logo_uri: null,
            has_token_page: null,
            asset_id: null,
        });
        const result = await listAssets(repoWith([metaOnly], null), { limit: 5, offset: 999_999 });
        expect(result.items).toEqual([]);
        expect(result.total).toBe(3293);
    });
});

describe('getByMint', () => {
    it('rejects a missing or malformed mint', () => {
        expect(() => parseSolanaDataGetByMintArgs({})).toThrow();
        expect(() => parseSolanaDataGetByMintArgs({ mint: 'nope' })).toThrow();
        expect(parseSolanaDataGetByMintArgs({ mint: ` ${USDC} ` })).toBe(USDC);
    });

    it('returns the item plus the parsed upstream row, timestamps, and provider fallback', async () => {
        const result = await getByMint(repoWith([], detailRow()), { mint: USDC });
        expect(result).not.toBeNull();
        expect(result!.mint).toBe(USDC);
        expect(result!.assetClass).toBe('USD Stablecoins');
        expect(result!.upstream).toEqual({
            token: 'USDC',
            mint_address: USDC,
            group: 'Stablecoins',
            coingecko_market_cap: '7.2677E10',
        });
        expect(result!.generatedAt).toBe('2026-10-13T18:54:28.395Z');
        expect(result!.syncedAt).toBe(1_791_926_904_939);
        expect(result!.provider).toEqual({ name: null, logoURI: null, fetchedAt: 1_791_926_000_000 });
    });

    it('returns null for an unknown mint and tolerates unparsable raw_json', async () => {
        expect(await getByMint(repoWith([], detailRow()), { mint: BONK })).toBeNull();
        const broken = rowToSolanaDataAssetDetailResult(detailRow({ raw_json: '{not json' }));
        expect(broken!.upstream).toEqual({});
    });
});
