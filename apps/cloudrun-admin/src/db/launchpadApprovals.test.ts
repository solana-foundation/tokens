/**
 * Transaction-body tests with a recording fake `tx` that answers each
 * statement by SQL text, asserting statement order and bound params.
 */

import { describe, expect, it } from 'bun:test';

import type { TransactionSql } from 'postgres';

import { approveInTx, revokeInTx } from './launchpadApprovals';

interface RecordedQuery {
    text: string;
    params: unknown[];
}

type Responder = (query: RecordedQuery) => unknown[];

function makeFakeTx(respond: Responder = () => []): { tx: TransactionSql; queries: RecordedQuery[] } {
    const queries: RecordedQuery[] = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = { text: strings.join('$'), params: values };
        queries.push(query);
        return respond(query);
    }) as unknown as TransactionSql;
    return { tx, queries };
}

const NOW = 1_750_000_000_000;
const EARLIER = 1_740_000_000_000;
const MINT = 'HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ';
const ACTOR = { clerkUserId: 'admin_1', email: 'admin@example.com' };

describe('approveInTx', () => {
    it('new approval: upsert (approved_at untouched on conflict) then approve event; created=true', async () => {
        const { tx, queries } = makeFakeTx(q =>
            q.text.includes('RETURNING approved_at') ? [{ approved_at: NOW }] : [],
        );
        const result = await approveInTx(tx, {
            launchpad: 'stonkfun',
            mint: MINT,
            note: 'team pick',
            snapshot: { quoteMint: 'Q', symbol: 'GP', name: 'RuneScape Gold', logoURI: null },
            actor: ACTOR,
            nowMs: NOW,
        });
        expect(result).toEqual({ created: true, approvedAt: NOW });

        expect(queries).toHaveLength(2);
        const [upsert, event] = queries;
        expect(upsert!.text).toContain('INSERT INTO launchpad_mint_approvals');
        expect(upsert!.text).toContain('ON CONFLICT (launchpad, mint) DO UPDATE');
        expect(upsert!.text).not.toContain('approved_at = EXCLUDED');
        expect(upsert!.text).toContain('COALESCE(EXCLUDED.note, launchpad_mint_approvals.note)');
        expect(upsert!.params).toEqual([
            'stonkfun',
            MINT,
            'team pick',
            'Q',
            'GP',
            'RuneScape Gold',
            null,
            'admin_1',
            'admin@example.com',
            NOW,
            NOW,
        ]);
        expect(upsert!.text).toContain('quote_mint = COALESCE(EXCLUDED.quote_mint');

        expect(event!.text).toContain('INSERT INTO launchpad_mint_approval_events');
        expect(event!.text).toContain("'approve'");
        expect(event!.params.slice(1)).toEqual(['stonkfun', MINT, 'team pick', 'admin_1', 'admin@example.com', NOW]);
        expect(String(event!.params[0])).toMatch(/^lma_/);
    });

    it('re-approval: returns the original approved_at with created=false', async () => {
        const { tx, queries } = makeFakeTx(q =>
            q.text.includes('RETURNING approved_at') ? [{ approved_at: String(EARLIER) }] : [],
        );
        const result = await approveInTx(tx, {
            launchpad: 'stonkfun',
            mint: MINT,
            note: null,
            snapshot: { quoteMint: null, symbol: null, name: null, logoURI: null },
            actor: { ...ACTOR, email: null },
            nowMs: NOW,
        });
        expect(result).toEqual({ created: false, approvedAt: EARLIER });
        expect(queries).toHaveLength(2);
        expect(queries[0]!.params).toEqual(['stonkfun', MINT, null, null, null, null, null, 'admin_1', null, NOW, NOW]);
    });
});

describe('revokeInTx', () => {
    it('deletes and records a revoke event', async () => {
        const { tx, queries } = makeFakeTx(q => (q.text.includes('DELETE FROM') ? [{ mint: MINT }] : []));
        expect(await revokeInTx(tx, { launchpad: 'stonkfun', mint: MINT, actor: ACTOR, nowMs: NOW })).toBe('revoked');
        expect(queries).toHaveLength(2);
        expect(queries[0]!.text).toContain('DELETE FROM launchpad_mint_approvals');
        expect(queries[0]!.params).toEqual(['stonkfun', MINT]);
        expect(queries[1]!.text).toContain("'revoke'");
        expect(queries[1]!.params.slice(1)).toEqual(['stonkfun', MINT, 'admin_1', 'admin@example.com', NOW]);
    });

    it('writes nothing else when there was no approval', async () => {
        const { tx, queries } = makeFakeTx(() => []);
        expect(await revokeInTx(tx, { launchpad: 'stonkfun', mint: MINT, actor: ACTOR, nowMs: NOW })).toBe('not_found');
        expect(queries).toHaveLength(1);
    });
});
