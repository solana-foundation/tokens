import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';
import {
    clearVariantAdvisory,
    listVariantAdvisories,
    setVariantAdvisory,
    type SetVariantAdvisoryOutcome,
    type VariantAdvisoriesDeps,
    type VariantAdvisoriesRepo,
    type VariantAdvisoryEventRow,
    type VariantAdvisoryRow,
} from './variantAdvisories';

const ADMIN = { clerkUserId: 'admin_1', email: 'admin@example.com' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);
const NOW = 1_750_000_000_000;
const MINT = 'SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';

interface RepoState {
    set?: SetVariantAdvisoryOutcome;
    clear?: 'cleared' | 'not_found';
    active?: VariantAdvisoryRow[];
    events?: VariantAdvisoryEventRow[];
}

function makeDeps(state: RepoState = {}): { deps: VariantAdvisoriesDeps; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const track = (name: string, args: unknown) => {
        (calls[name] ??= []).push(args);
    };
    const repo: VariantAdvisoriesRepo = {
        set: async args => {
            track('set', args);
            return state.set ?? { outcome: 'set', reactivated: false };
        },
        clear: async args => {
            track('clear', args);
            return state.clear ?? 'cleared';
        },
        listActive: async () => {
            track('listActive', undefined);
            return state.active ?? [];
        },
        listEventsByMint: async (mint, limit) => {
            track('listEventsByMint', { mint, limit });
            return state.events ?? [];
        },
    };
    return {
        deps: { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() }, now: () => NOW },
        calls,
    };
}

function advisoryRow(overrides: Partial<VariantAdvisoryRow> = {}): VariantAdvisoryRow {
    return {
        mint: MINT,
        status: 'compromised',
        reason: 'Treasury exploited',
        url: null,
        setBy: 'admin_1',
        setByEmail: null,
        setAt: NOW - 1000,
        updatedAt: NOW - 1000,
        ...overrides,
    };
}

const VALID_SET_ARGS = { mint: MINT, status: 'compromised', reason: 'Treasury exploited' };

describe('authz', () => {
    const handlers: Array<[string, (deps: VariantAdvisoriesDeps, args: unknown, identity: { clerkUserId: string } | null) => Promise<unknown>, unknown]> = [
        ['setVariantAdvisory', setVariantAdvisory, VALID_SET_ARGS],
        ['clearVariantAdvisory', clearVariantAdvisory, { mint: MINT }],
        ['listVariantAdvisories', listVariantAdvisories, {}],
    ];

    for (const [name, handler, args] of handlers) {
        it(`${name} requires an identity`, async () => {
            const { deps, calls } = makeDeps();
            await expect(handler(deps, args, null)).rejects.toBeInstanceOf(IdentityRequiredError);
            expect(Object.keys(calls)).toHaveLength(0);
        });

        it(`${name} rejects non-admins`, async () => {
            const { deps, calls } = makeDeps();
            await expect(handler(deps, args, { clerkUserId: 'not_admin' })).rejects.toBeInstanceOf(UnauthorizedError);
            expect(Object.keys(calls)).toHaveLength(0);
        });
    }
});

describe('setVariantAdvisory', () => {
    let logSpy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => {
        logSpy?.mockRestore();
        logSpy = null;
    });

    it('validates args (each failure is an InvalidArgsError, repo untouched)', async () => {
        const { deps, calls } = makeDeps();
        const bad: unknown[] = [
            [],
            { ...VALID_SET_ARGS, mint: undefined },
            { ...VALID_SET_ARGS, mint: 'not-a-mint' },
            { ...VALID_SET_ARGS, mint: 'O0Il' + 'a'.repeat(30) }, // non-base58 chars
            { ...VALID_SET_ARGS, status: 'quarantined' },
            { ...VALID_SET_ARGS, status: undefined },
            { ...VALID_SET_ARGS, reason: '' },
            { ...VALID_SET_ARGS, reason: '   ' },
            { ...VALID_SET_ARGS, reason: 'x'.repeat(501) },
            { ...VALID_SET_ARGS, reason: 42 },
            { ...VALID_SET_ARGS, url: 'not a url' },
            { ...VALID_SET_ARGS, url: 'ftp://files.example.com/x' },
            { ...VALID_SET_ARGS, url: 'javascript:alert(1)' },
            { ...VALID_SET_ARGS, url: 123 },
            { ...VALID_SET_ARGS, activateVariant: 'yes' },
        ];
        for (const args of bad) {
            await expect(setVariantAdvisory(deps, args, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        }
        expect(calls.set).toBeUndefined();
    });

    it('happy path: trims, defaults url null + activateVariant false, passes actor + now, returns contract', async () => {
        const { deps, calls } = makeDeps();
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const result = await setVariantAdvisory(
            deps,
            { mint: `  ${MINT}  `, status: 'compromised', reason: '  Treasury exploited  ' },
            ADMIN,
        );
        expect(result).toEqual({ mint: MINT, status: 'compromised', updated: true, reactivated: false });
        expect(calls.set).toEqual([
            {
                mint: MINT,
                status: 'compromised',
                reason: 'Treasury exploited',
                url: null,
                activateVariant: false,
                actor: { clerkUserId: 'admin_1', email: 'admin@example.com' },
                nowMs: NOW,
            },
        ]);
        expect(logSpy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(String((logSpy.mock.calls[0] as unknown[])[0]));
        expect(logged).toEqual({
            event: 'mutation',
            mutation: 'setVariantAdvisory',
            mint: MINT,
            status: 'compromised',
            clerkUserId: 'admin_1',
            email: 'admin@example.com',
        });
    });

    it('passes a trimmed http(s) url and activateVariant through; surfaces reactivated', async () => {
        const { deps, calls } = makeDeps({ set: { outcome: 'set', reactivated: true } });
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const result = await setVariantAdvisory(
            deps,
            { ...VALID_SET_ARGS, url: '  https://sunrise.example/silv  ', activateVariant: true },
            ADMIN,
        );
        expect(result.reactivated).toBe(true);
        const call = calls.set![0] as { url: string | null; activateVariant: boolean };
        expect(call.url).toBe('https://sunrise.example/silv');
        expect(call.activateVariant).toBe(true);
    });

    it('treats null and blank url as null', async () => {
        const { deps, calls } = makeDeps();
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        await setVariantAdvisory(deps, { ...VALID_SET_ARGS, url: null }, ADMIN);
        await setVariantAdvisory(deps, { ...VALID_SET_ARGS, url: '   ' }, ADMIN);
        expect((calls.set as Array<{ url: string | null }>).map(c => c.url)).toEqual([null, null]);
    });

    it('email is null in the actor when the identity has none', async () => {
        const { deps, calls } = makeDeps();
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        await setVariantAdvisory(deps, VALID_SET_ARGS, { clerkUserId: 'admin_1' });
        expect((calls.set![0] as { actor: unknown }).actor).toEqual({ clerkUserId: 'admin_1', email: null });
        const logged = JSON.parse(String((logSpy.mock.calls[0] as unknown[])[0]));
        expect(logged.email).toBeNull();
    });

    it('maps variant_not_found to InvalidArgsError and does not log', async () => {
        const { deps } = makeDeps({ set: { outcome: 'variant_not_found' } });
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        await expect(setVariantAdvisory(deps, VALID_SET_ARGS, ADMIN)).rejects.toThrow(
            new InvalidArgsError('Variant not found'),
        );
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe('clearVariantAdvisory', () => {
    let logSpy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => {
        logSpy?.mockRestore();
        logSpy = null;
    });

    it('validates mint', async () => {
        const { deps, calls } = makeDeps();
        for (const args of [{}, { mint: 'nope' }, { mint: 12 }]) {
            await expect(clearVariantAdvisory(deps, args, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        }
        expect(calls.clear).toBeUndefined();
    });

    it('returns cleared=true and logs when an advisory existed', async () => {
        const { deps, calls } = makeDeps({ clear: 'cleared' });
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const result = await clearVariantAdvisory(deps, { mint: ` ${MINT} ` }, ADMIN);
        expect(result).toEqual({ mint: MINT, cleared: true });
        expect(calls.clear).toEqual([{ mint: MINT, actor: { clerkUserId: 'admin_1', email: 'admin@example.com' }, nowMs: NOW }]);
        const logged = JSON.parse(String((logSpy.mock.calls[0] as unknown[])[0]));
        expect(logged).toEqual({
            event: 'mutation',
            mutation: 'clearVariantAdvisory',
            mint: MINT,
            status: null,
            clerkUserId: 'admin_1',
            email: 'admin@example.com',
        });
    });

    it('returns cleared=false (no error, no log) when nothing was active', async () => {
        const { deps } = makeDeps({ clear: 'not_found' });
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const result = await clearVariantAdvisory(deps, { mint: MINT }, ADMIN);
        expect(result).toEqual({ mint: MINT, cleared: false });
        expect(logSpy).not.toHaveBeenCalled();
    });
});

describe('listVariantAdvisories', () => {
    it('without mint returns every active advisory and no events', async () => {
        const rows = [advisoryRow(), advisoryRow({ mint: OTHER_MINT, status: 'caution' })];
        const { deps, calls } = makeDeps({ active: rows });
        const result = await listVariantAdvisories(deps, {}, ADMIN);
        expect(result).toEqual({ advisories: rows, events: [] });
        expect(calls.listEventsByMint).toBeUndefined();
    });

    it('accepts undefined args as an empty object', async () => {
        const { deps } = makeDeps();
        expect(await listVariantAdvisories(deps, undefined, ADMIN)).toEqual({ advisories: [], events: [] });
    });

    it('with mint filters advisories to that mint and fetches events with the default limit', async () => {
        const rows = [advisoryRow(), advisoryRow({ mint: OTHER_MINT, status: 'caution' })];
        const event: VariantAdvisoryEventRow = {
            id: 'ave_1',
            mint: MINT,
            action: 'set',
            status: 'compromised',
            reason: 'Treasury exploited',
            url: null,
            reactivatedVariant: true,
            actorClerkUserId: 'admin_1',
            actorEmail: null,
            createdAt: NOW - 1000,
        };
        const { deps, calls } = makeDeps({ active: rows, events: [event] });
        const result = await listVariantAdvisories(deps, { mint: ` ${MINT} ` }, ADMIN);
        expect(result).toEqual({ advisories: [rows[0]!], events: [event] });
        expect(calls.listEventsByMint).toEqual([{ mint: MINT, limit: 20 }]);
    });

    it('clamps eventsLimit to 1..100 and floors it', async () => {
        const { deps, calls } = makeDeps();
        await listVariantAdvisories(deps, { mint: MINT, eventsLimit: 7.9 }, ADMIN);
        await listVariantAdvisories(deps, { mint: MINT, eventsLimit: 0 }, ADMIN);
        await listVariantAdvisories(deps, { mint: MINT, eventsLimit: 500 }, ADMIN);
        expect((calls.listEventsByMint as Array<{ limit: number }>).map(c => c.limit)).toEqual([7, 1, 100]);
    });

    it('rejects a malformed mint or non-numeric eventsLimit', async () => {
        const { deps } = makeDeps();
        await expect(listVariantAdvisories(deps, { mint: 'bad' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        await expect(listVariantAdvisories(deps, { mint: MINT, eventsLimit: 'ten' }, ADMIN)).rejects.toBeInstanceOf(
            InvalidArgsError,
        );
    });
});
