/**
 * Transaction-body tests with a recording fake `tx` that answers each
 * statement by SQL text, asserting statement order and bound params.
 */

import { describe, expect, it } from 'bun:test';

import type { TransactionSql } from 'postgres';

import { clearAdvisoryInTx, setAdvisoryInTx } from './variantAdvisories';

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
const MINT = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
const ACTOR = { clerkUserId: 'admin_1', email: 'admin@example.com' };

function variantResponder(opts: {
    variant: { id: string; is_active: boolean } | null;
    existing?: { status: string; set_at: string | number } | null;
}): Responder {
    return q => {
        if (q.text.includes('FROM asset_variants')) return opts.variant ? [opts.variant] : [];
        if (q.text.includes('SELECT status, set_at')) return opts.existing ? [opts.existing] : [];
        return [];
    };
}

const baseSetArgs = {
    mint: MINT,
    status: 'compromised' as const,
    reason: 'Treasury exploited',
    url: 'https://sunrise.example/silv',
    activateVariant: false,
    actor: ACTOR,
    nowMs: NOW,
};

describe('setAdvisoryInTx', () => {
    it('returns variant_not_found after only the locking SELECT when the mint has no variant', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: null }));
        const result = await setAdvisoryInTx(tx, baseSetArgs);
        expect(result).toEqual({ outcome: 'variant_not_found' });
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('FROM asset_variants');
        expect(queries[0]!.text).toContain('FOR UPDATE');
        expect(queries[0]!.params).toEqual([MINT]);
    });

    it('new advisory: lock variant, read current, upsert with set_at = now, event with reactivated=false', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: { id: 'avr_1', is_active: true }, existing: null }));
        const result = await setAdvisoryInTx(tx, baseSetArgs);
        expect(result).toEqual({ outcome: 'set', reactivated: false });

        expect(queries.map(q => q.text.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual([
            'SELECT id,',
            'SELECT status,',
            'INSERT INTO',
            'INSERT INTO',
        ]);
        const [lockVariant, readCurrent, upsert, event] = queries;
        expect(lockVariant!.text).toContain('ORDER BY id ASC');
        expect(readCurrent!.text).toContain('FROM asset_variant_advisories');
        expect(readCurrent!.text).toContain('FOR UPDATE');
        expect(readCurrent!.params).toEqual([MINT]);

        expect(upsert!.text).toContain('INSERT INTO asset_variant_advisories');
        expect(upsert!.text).toContain('ON CONFLICT (mint) DO UPDATE');
        // Human writes always (re)claim the row from the depeg automation.
        expect(upsert!.text).toContain("'admin', false");
        expect(upsert!.text).toContain("source = 'admin'");
        expect(upsert!.text).toContain('managed_by_system = false');
        // (mint, status, reason, url, set_by, set_by_email, set_at, updated_at)
        expect(upsert!.params).toEqual([
            MINT,
            'compromised',
            'Treasury exploited',
            'https://sunrise.example/silv',
            'admin_1',
            'admin@example.com',
            NOW,
            NOW,
        ]);

        expect(event!.text).toContain('INSERT INTO asset_variant_advisory_events');
        expect(event!.text).toContain("'set'");
        expect(event!.text).toContain("'admin'");
        // (id, mint, status, reason, url, reactivated, actor id, actor email, created_at)
        const [id, mint, status, reason, url, reactivated, actorId, actorEmail, createdAt] = event!.params;
        expect(String(id)).toMatch(/^ave_[0-9a-f]{32}$/);
        expect(mint).toBe(MINT);
        expect(status).toBe('compromised');
        expect(reason).toBe('Treasury exploited');
        expect(url).toBe('https://sunrise.example/silv');
        expect(reactivated).toBe(false);
        expect(actorId).toBe('admin_1');
        expect(actorEmail).toBe('admin@example.com');
        expect(createdAt).toBe(NOW);
    });

    it('keeps set_at when the status is unchanged (reason/url edit)', async () => {
        const { tx, queries } = makeFakeTx(
            variantResponder({
                variant: { id: 'avr_1', is_active: true },
                existing: { status: 'compromised', set_at: String(EARLIER) }, // bigint arrives as string
            }),
        );
        await setAdvisoryInTx(tx, { ...baseSetArgs, reason: 'Updated reason' });
        const upsert = queries.find(q => q.text.includes('INSERT INTO asset_variant_advisories'))!;
        expect(upsert.params[6]).toBe(EARLIER); // set_at preserved (and coerced to number)
        expect(upsert.params[7]).toBe(NOW); // updated_at bumped
    });

    it('resets set_at when the status changes', async () => {
        const { tx, queries } = makeFakeTx(
            variantResponder({
                variant: { id: 'avr_1', is_active: true },
                existing: { status: 'caution', set_at: EARLIER },
            }),
        );
        await setAdvisoryInTx(tx, baseSetArgs);
        const upsert = queries.find(q => q.text.includes('INSERT INTO asset_variant_advisories'))!;
        expect(upsert.params[6]).toBe(NOW);
    });

    it('activateVariant on an inactive variant: UPDATE asset_variants between upsert and event; reactivated=true', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: { id: 'avr_silv', is_active: false } }));
        const result = await setAdvisoryInTx(tx, { ...baseSetArgs, activateVariant: true });
        expect(result).toEqual({ outcome: 'set', reactivated: true });

        expect(queries).toHaveLength(5);
        const update = queries[3]!;
        expect(update.text).toContain('UPDATE asset_variants');
        expect(update.text).toContain('is_active = true');
        expect(update.params[0]).toBeInstanceOf(Date);
        expect((update.params[0] as Date).getTime()).toBe(NOW);
        expect(update.params[1]).toBe('avr_silv');

        const event = queries[4]!;
        expect(event.text).toContain('asset_variant_advisory_events');
        expect(event.params[5]).toBe(true); // reactivated_variant
    });

    it('activateVariant on an already-active variant is a no-op (no UPDATE, reactivated=false)', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: { id: 'avr_1', is_active: true } }));
        const result = await setAdvisoryInTx(tx, { ...baseSetArgs, activateVariant: true });
        expect(result).toEqual({ outcome: 'set', reactivated: false });
        expect(queries).toHaveLength(4);
        expect(queries.some(q => q.text.includes('UPDATE asset_variants'))).toBe(false);
        expect(queries[3]!.params[5]).toBe(false);
    });

    it('does not touch asset_variants when activateVariant is false even if inactive', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: { id: 'avr_1', is_active: false } }));
        const result = await setAdvisoryInTx(tx, baseSetArgs);
        expect(result).toEqual({ outcome: 'set', reactivated: false });
        expect(queries.some(q => q.text.includes('UPDATE asset_variants'))).toBe(false);
    });

    it('binds null url and null actor email', async () => {
        const { tx, queries } = makeFakeTx(variantResponder({ variant: { id: 'avr_1', is_active: true } }));
        await setAdvisoryInTx(tx, { ...baseSetArgs, url: null, actor: { clerkUserId: 'admin_1', email: null } });
        const upsert = queries[2]!;
        expect(upsert.params[3]).toBeNull();
        expect(upsert.params[5]).toBeNull();
        const event = queries[3]!;
        expect(event.params[4]).toBeNull();
        expect(event.params[7]).toBeNull();
    });
});

describe('clearAdvisoryInTx', () => {
    it('deletes and records a clear event when an advisory existed', async () => {
        const { tx, queries } = makeFakeTx(q => (q.text.includes('DELETE FROM') ? [{ mint: MINT }] : []));
        const result = await clearAdvisoryInTx(tx, { mint: MINT, actor: ACTOR, nowMs: NOW });
        expect(result).toBe('cleared');
        expect(queries).toHaveLength(2);

        const del = queries[0]!;
        expect(del.text).toContain('DELETE FROM asset_variant_advisories');
        expect(del.text).toContain('RETURNING mint');
        expect(del.params).toEqual([MINT]);

        const event = queries[1]!;
        expect(event.text).toContain('INSERT INTO asset_variant_advisory_events');
        expect(event.text).toContain("'clear'");
        expect(event.text).toContain('NULL, NULL, NULL, false');
        expect(event.text).toContain("'admin'");
        // (id, mint, actor id, actor email, created_at)
        const [id, mint, actorId, actorEmail, createdAt] = event.params;
        expect(String(id)).toMatch(/^ave_[0-9a-f]{32}$/);
        expect(mint).toBe(MINT);
        expect(actorId).toBe('admin_1');
        expect(actorEmail).toBe('admin@example.com');
        expect(createdAt).toBe(NOW);
    });

    it('returns not_found and writes no event when nothing was deleted', async () => {
        const { tx, queries } = makeFakeTx(() => []);
        const result = await clearAdvisoryInTx(tx, { mint: MINT, actor: ACTOR, nowMs: NOW });
        expect(result).toBe('not_found');
        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain('DELETE FROM asset_variant_advisories');
    });
});
