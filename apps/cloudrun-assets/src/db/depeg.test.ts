/**
 * Transaction-body tests for the system advisory write with a recording fake
 * `tx` (same style as cloudrun-admin/src/db/variantAdvisories.test.ts).
 */

import { describe, expect, it } from 'bun:test';

import type { TransactionSql } from 'postgres';

import { WEBACY_DEPEG_ACTOR } from '@tokens/asset-registry';

import { clearSystemAdvisoryInTx, setSystemAdvisoryInTx } from './depeg';

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

const NOW = 1_789_000_000_000;
const EARLIER = 1_788_000_000_000;
const MINT = 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT';
const REASON = "Webacy's depeg monitor rates USDe Warning: trading 2.40% below its $1 peg as of 2026-09-13 14:05 UTC.";

function responder(opts: {
    variant: boolean;
    existing?: {
        status: string;
        reason: string;
        source: string;
        managed_by_system: boolean;
        set_at: number | string;
    } | null;
}): Responder {
    return q => {
        if (q.text.includes('FROM asset_variants')) return opts.variant ? [{ id: 'avr_1' }] : [];
        if (q.text.includes('SELECT status, reason, source, managed_by_system, set_at'))
            return opts.existing ? [opts.existing] : [];
        return [];
    };
}

describe('setSystemAdvisoryInTx', () => {
    it('returns variant_not_found after only the active-variant lock when no active variant exists', async () => {
        const { tx, queries } = makeFakeTx(responder({ variant: false }));
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('variant_not_found');
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('FROM asset_variants');
        expect(queries[0]!.text).toContain('is_active = true');
        expect(queries[0]!.text).toContain('FOR UPDATE');
        expect(queries[0]!.params).toEqual([MINT]);
    });

    it('never writes over a human-owned row: skipped_human_owned with no INSERT and no event', async () => {
        const { tx, queries } = makeFakeTx(
            responder({
                variant: true,
                existing: {
                    status: 'caution',
                    reason: 'Issuer paused redemptions.',
                    source: 'admin',
                    managed_by_system: false,
                    set_at: EARLIER,
                },
            }),
        );
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('skipped_human_owned');
        expect(queries).toHaveLength(2);
        expect(queries.some(q => q.text.includes('INSERT INTO'))).toBe(false);
    });

    it('never overwrites a row the other observer set (skipped_other_system_owner, no write)', async () => {
        const { tx, queries } = makeFakeTx(q => {
            if (q.text.includes('FROM asset_variants')) return [{ id: 'avr_1' }];
            if (q.text.includes('SELECT status, reason, source, managed_by_system, set_at'))
                return [
                    { status: 'caution', reason: 'x', source: 'peg_guard', managed_by_system: true, set_at: EARLIER },
                ];
            return [];
        });
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('skipped_other_system_owner');
        expect(queries.some(q => q.text.includes('INSERT INTO'))).toBe(false);
    });

    it('writes the peg guard actor and source when the peg guard sets', async () => {
        const { tx, queries } = makeFakeTx(q => (q.text.includes('FROM asset_variants') ? [{ id: 'avr_1' }] : []));
        expect(await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'peg_guard' })).toBe(
            'set',
        );
        const upsert = queries.find(q => q.text.includes('INSERT INTO asset_variant_advisories'))!;
        expect(upsert.params).toContain('peg_guard');
        expect(upsert.params).toContain('system:peg_guard');
        expect(upsert.params).not.toContain('webacy_depeg');
    });

    it('treats a pre-0019 row (managed_by_system null) as human-owned', async () => {
        const { tx, queries } = makeFakeTx(q => {
            if (q.text.includes('FROM asset_variants')) return [{ id: 'avr_1' }];
            if (q.text.includes('SELECT status, reason')) {
                return [{ status: 'caution', reason: 'x', source: null, managed_by_system: null, set_at: EARLIER }];
            }
            return [];
        });
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('skipped_human_owned');
        expect(queries).toHaveLength(2);
    });

    it('returns unchanged without writing when the system row already carries the same reason', async () => {
        const { tx, queries } = makeFakeTx(
            responder({
                variant: true,
                existing: {
                    status: 'caution',
                    reason: REASON,
                    source: 'webacy_depeg',
                    managed_by_system: true,
                    set_at: EARLIER,
                },
            }),
        );
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('unchanged');
        expect(queries).toHaveLength(2);
    });

    it('new advisory: upsert as caution with the sentinel actor, source and managed flag, then a system event', async () => {
        const { tx, queries } = makeFakeTx(responder({ variant: true, existing: null }));
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('set');

        expect(queries.map(q => q.text.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
            'SELECT id',
            'SELECT status,',
            'INSERT INTO',
            'INSERT INTO',
        ]);
        const [, readCurrent, upsert, event] = queries;
        expect(readCurrent!.text).toContain('FOR UPDATE');

        expect(upsert!.text).toContain('INSERT INTO asset_variant_advisories');
        expect(upsert!.text).toContain("'caution'");
        expect(upsert!.params).toContain('webacy_depeg');
        expect(upsert!.params).toContain('system:webacy_depeg');
        expect(upsert!.text).toContain('AND asset_variant_advisories.source = $');
        expect(upsert!.text).toContain('ON CONFLICT (mint) DO UPDATE');
        // The conditional upsert is the last line of defence against racing a human edit.
        expect(upsert!.text).toContain('WHERE asset_variant_advisories.managed_by_system = true');
        expect(upsert!.text).toContain('set_by_email = NULL');
        expect(upsert!.text).not.toContain('status = EXCLUDED.status');
        // (mint, reason, set_by, set_at, updated_at, source, [ON CONFLICT] source)
        expect(upsert!.params).toEqual([MINT, REASON, WEBACY_DEPEG_ACTOR, NOW, NOW, 'webacy_depeg', 'webacy_depeg']);

        expect(event!.text).toContain('INSERT INTO asset_variant_advisory_events');
        expect(event!.text).toContain("'set', 'caution'");
        expect(event!.params).toContain('webacy_depeg');
        expect(event!.params).toContain('system:webacy_depeg');
        const [id, mint, reason, actor, createdAt] = event!.params;
        expect(String(id)).toMatch(/^ave_/);
        expect(mint).toBe(MINT);
        expect(reason).toBe(REASON);
        expect(actor).toBe(WEBACY_DEPEG_ACTOR);
        expect(createdAt).toBe(NOW);
    });

    it('re-wording an existing system row preserves set_at and returns updated', async () => {
        const { tx, queries } = makeFakeTx(
            responder({
                variant: true,
                existing: {
                    status: 'caution',
                    reason: 'older warning text',
                    source: 'webacy_depeg',
                    managed_by_system: true,
                    set_at: String(EARLIER), // bigint arrives as string
                },
            }),
        );
        expect(
            await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' }),
        ).toBe('updated');
        const upsert = queries.find(q => q.text.includes('INSERT INTO asset_variant_advisories'))!;
        expect(upsert.params[3]).toBe(EARLIER);
        expect(upsert.params[4]).toBe(NOW);
    });

    it('never mentions compromised, blocked or variant re-activation', async () => {
        const { tx, queries } = makeFakeTx(responder({ variant: true, existing: null }));
        await setSystemAdvisoryInTx(tx, { mint: MINT, reason: REASON, nowMs: NOW, source: 'webacy_depeg' });
        const allSql = queries.map(q => q.text).join('\n');
        expect(allSql).not.toContain('compromised');
        expect(allSql).not.toContain('blocked');
        expect(allSql).not.toContain('UPDATE asset_variants');
    });
});

describe('clearSystemAdvisoryInTx', () => {
    it('deletes only system-owned webacy rows and records a system clear event with the note as reason', async () => {
        const { tx, queries } = makeFakeTx(q => (q.text.includes('DELETE FROM') ? [{ mint: MINT }] : []));
        expect(
            await clearSystemAdvisoryInTx(tx, {
                mint: MINT,
                note: 'Webacy tier ok for 6h',
                nowMs: NOW,
                source: 'webacy_depeg',
            }),
        ).toBe('cleared');

        expect(queries).toHaveLength(2);
        const [del, event] = queries;
        expect(del!.text).toContain('DELETE FROM asset_variant_advisories');
        expect(del!.text).toContain('managed_by_system = true');
        expect(del!.text).toContain('source = $');
        expect(del!.params).toEqual([MINT, 'webacy_depeg']);
        expect(del!.text).toContain('RETURNING mint');

        expect(event!.text).toContain("'clear'");
        expect(event!.params).toContain('webacy_depeg');
        expect(event!.params).toContain('system:webacy_depeg');
        const [id, mint, note, actor, createdAt] = event!.params;
        expect(String(id)).toMatch(/^ave_/);
        expect(mint).toBe(MINT);
        expect(note).toBe('Webacy tier ok for 6h');
        expect(actor).toBe(WEBACY_DEPEG_ACTOR);
        expect(createdAt).toBe(NOW);
    });

    it('returns skipped_not_system without an event when a human row exists', async () => {
        const { tx, queries } = makeFakeTx(q =>
            q.text.includes('SELECT mint, managed_by_system, source FROM asset_variant_advisories')
                ? [{ mint: MINT, managed_by_system: false, source: 'admin' }]
                : [],
        );
        expect(await clearSystemAdvisoryInTx(tx, { mint: MINT, note: 'n', nowMs: NOW, source: 'webacy_depeg' })).toBe(
            'skipped_not_system',
        );
        expect(queries).toHaveLength(2);
        expect(queries.some(q => q.text.includes('INSERT INTO'))).toBe(false);
    });

    it('returns skipped_other_system_owner without an event when the row belongs to the other observer', async () => {
        const { tx, queries } = makeFakeTx(q =>
            q.text.includes('SELECT mint, managed_by_system, source FROM asset_variant_advisories')
                ? [{ mint: MINT, managed_by_system: true, source: 'peg_guard' }]
                : [],
        );
        expect(await clearSystemAdvisoryInTx(tx, { mint: MINT, note: 'n', nowMs: NOW, source: 'webacy_depeg' })).toBe(
            'skipped_other_system_owner',
        );
        expect(queries.some(q => q.text.includes('INSERT INTO'))).toBe(false);
    });

    it('returns not_found without an event when no row exists at all', async () => {
        const { tx, queries } = makeFakeTx();
        expect(await clearSystemAdvisoryInTx(tx, { mint: MINT, note: 'n', nowMs: NOW, source: 'webacy_depeg' })).toBe(
            'not_found',
        );
        expect(queries).toHaveLength(2);
        expect(queries.some(q => q.text.includes('INSERT INTO'))).toBe(false);
    });
});
