import { describe, expect, it } from 'bun:test';

import { getLatestByMints, securityFromPayloads, type AssetRiskReadsRepo, type AssetRiskRow } from './assetRiskReads';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function row(overrides: Partial<AssetRiskRow> = {}): AssetRiskRow {
    return {
        mint: MINT,
        asset_id: 'usd',
        ok: true,
        tags: [{ key: 'is_mintable', name: 'Mintable', type: 'warning', severity: 2 }, 'freezeable'],
        lp_locked_percent: 85.5,
        top_10_holders_percent: 42.1,
        holder_count: 9_500_000,
        token_mint_time: '2020-10-01T00:00:00Z',
        risk_score_10: 1,
        safety_score_10: 9,
        last_fetched_at: 1_700_000_000_000,
        token_risk: {
            is_mintable: true,
            freezeable: true,
            'mutable-metadata': false,
            renounced: false,
            buy_sell_taxes: { buy_tax: 0, sell_tax: 0 },
        },
        token_info: { is_metadata_immutable: true },
        trading_lite: {
            DevHoldingPercentage: '3.5',
            SniperPercentageHolding: 0.4,
            BundlerPercentageHolding: null,
            mintable: false,
        },
        ...overrides,
    };
}

function repo(rows: AssetRiskRow[]): AssetRiskReadsRepo & { calls: string[][] } {
    const calls: string[][] = [];
    return {
        calls,
        async findLatestByMints(mints) {
            calls.push([...mints]);
            return rows.filter(r => mints.includes(r.mint));
        },
    };
}

describe('getLatestByMints', () => {
    it('validates args', async () => {
        await expect(getLatestByMints(repo([]), null)).rejects.toThrow('args must be an object');
        await expect(getLatestByMints(repo([]), { mints: 'x' })).rejects.toThrow('mints must be an array');
        await expect(getLatestByMints(repo([]), { mints: [1] })).rejects.toThrow('mints must be an array');
        expect(await getLatestByMints(repo([]), { mints: [] })).toEqual([]);
    });

    it('returns one entry per requested mint, in input order, null when there is no row', async () => {
        const out = await getLatestByMints(repo([row()]), { mints: [OTHER, MINT] });
        expect(out.map(e => e.mint)).toEqual([OTHER, MINT]);
        expect(out[0]!.risk).toBeNull();
        const doc = out[1]!.risk!;
        expect(doc).toMatchObject({
            mint: MINT,
            assetId: 'usd',
            top10HoldersPercent: 42.1,
            holderCount: 9_500_000,
            tokenMintTime: '2020-10-01T00:00:00.000Z',
            lpLockedPercent: 85.5,
            riskScore10: 1,
            safetyScore10: 9,
            tags: ['is_mintable', 'freezeable'],
            lastFetchedAt: 1_700_000_000_000,
        });
        expect(doc.security).toEqual({
            mintable: true,
            freezable: true,
            mutableMetadata: false,
            renounced: false,
            transferTax: false,
            devHoldingPercent: 3.5,
            sniperHoldingPercent: 0.4,
            bundlerHoldingPercent: null,
        });
    });

    it('a failed cron row (ok=false) is unknown, not a verdict', async () => {
        const out = await getLatestByMints(repo([row({ ok: false })]), { mints: [MINT] });
        expect(out[0]!.risk).toBeNull();
    });

    it('the freshest row wins when a mint has several', async () => {
        const stale = row({ asset_id: 'old', last_fetched_at: 1, top_10_holders_percent: 99 });
        const fresh = row({ asset_id: 'new', last_fetched_at: 2, top_10_holders_percent: 10 });
        const out = await getLatestByMints(repo([stale, fresh]), { mints: [MINT] });
        expect(out[0]!.risk?.assetId).toBe('new');
        expect(out[0]!.risk?.top10HoldersPercent).toBe(10);
    });

    it('caps at 250 mints and trims', async () => {
        const r = repo([]);
        await getLatestByMints(r, { mints: [` ${MINT} `, ...Array.from({ length: 300 }, () => OTHER)] });
        expect(r.calls[0]!.length).toBe(250);
        expect(r.calls[0]![0]).toBe(MINT);
    });
});

describe('securityFromPayloads', () => {
    it('is null when nothing is stored, and never invents a flag', () => {
        expect(securityFromPayloads(null, null, null)).toBeNull();
        expect(securityFromPayloads({}, null, null)).toEqual({
            mintable: null,
            freezable: null,
            mutableMetadata: null,
            renounced: null,
            transferTax: null,
            devHoldingPercent: null,
            sniperHoldingPercent: null,
            bundlerHoldingPercent: null,
        });
    });

    it('accepts JSON strings, string booleans and falls back to the trading payload', () => {
        const sec = securityFromPayloads(
            JSON.stringify({ is_mintable: 'false', buy_sell_taxes: { sell_tax: 5 } }),
            null,
            JSON.stringify({ freezable: true, DevHoldingPercentage: 150 }),
        )!;
        expect(sec.mintable).toBe(false);
        expect(sec.freezable).toBe(true);
        expect(sec.transferTax).toBe(true);
        expect(sec.devHoldingPercent).toBe(100); // clamped
    });

    it('derives mutable metadata from token_info when token_risk lacks it', () => {
        expect(securityFromPayloads({}, { is_metadata_immutable: false }, null)!.mutableMetadata).toBe(true);
        expect(securityFromPayloads({}, { is_metadata_immutable: true }, null)!.mutableMetadata).toBe(false);
    });
});
