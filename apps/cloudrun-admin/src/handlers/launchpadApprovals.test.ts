import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { IdentityRequiredError, InvalidArgsError, UnauthorizedError } from './errors';
import {
    approveLaunchpadMint,
    listLaunchpadCandidates,
    revokeLaunchpadMint,
    type LaunchpadApprovalsDeps,
    type LaunchpadApprovalsRepo,
    type LaunchpadCandidateRow,
} from './launchpadApprovals';

const ADMIN = { clerkUserId: 'admin_1', email: 'admin@example.com' };
const ADMIN_IDS: ReadonlySet<string> = new Set(['admin_1']);
const NOW = 1_750_000_000_000;
const MINT = 'HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ';

interface RepoState {
    approve?: { created: boolean; approvedAt: number };
    revoke?: 'revoked' | 'not_found';
    candidates?: LaunchpadCandidateRow[];
}

function makeDeps(state: RepoState = {}): { deps: LaunchpadApprovalsDeps; calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {};
    const track = (name: string, args: unknown) => {
        (calls[name] ??= []).push(args);
    };
    const repo: LaunchpadApprovalsRepo = {
        listCandidates: async args => {
            track('listCandidates', args);
            return state.candidates ?? [];
        },
        approve: async args => {
            track('approve', args);
            return state.approve ?? { created: true, approvedAt: NOW };
        },
        revoke: async args => {
            track('revoke', args);
            return state.revoke ?? 'revoked';
        },
    };
    return {
        deps: { repo, adminAllowlist: { clerkUserIds: ADMIN_IDS, emails: new Set<string>() }, now: () => NOW },
        calls,
    };
}

function candidate(overrides: Partial<LaunchpadCandidateRow> = {}): LaunchpadCandidateRow {
    return {
        launchpad: 'stonkfun',
        mint: MINT,
        synced: true,
        isActive: true,
        quoteMint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re',
        quoteSymbol: 'GLDX',
        symbol: 'GP',
        name: 'RuneScape Gold',
        logoURI: null,
        marketCapUsd: 3_800_000,
        volume24hUsd: 536_000,
        launchedAt: NOW - 86_400_000,
        lastSyncedAt: NOW - 60_000,
        quoteAsset: { assetId: 'gold', name: 'Gold', symbol: 'GLD', imageUrl: null },
        approval: null,
        ...overrides,
    };
}

describe('authz', () => {
    const handlers: Array<
        [
            string,
            (deps: LaunchpadApprovalsDeps, args: unknown, identity: { clerkUserId: string } | null) => Promise<unknown>,
            unknown,
        ]
    > = [
        ['listLaunchpadCandidates', listLaunchpadCandidates, {}],
        ['approveLaunchpadMint', approveLaunchpadMint, { mint: MINT }],
        ['revokeLaunchpadMint', revokeLaunchpadMint, { mint: MINT }],
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

describe('listLaunchpadCandidates', () => {
    it('defaults launchpad/approvedOnly/limit and passes them to the repo', async () => {
        const { deps, calls } = makeDeps({ candidates: [candidate()] });
        const rows = await listLaunchpadCandidates(deps, {}, ADMIN);
        expect(rows).toHaveLength(1);
        expect(calls.listCandidates).toEqual([{ launchpad: 'stonkfun', approvedOnly: false, limit: 200 }]);
    });

    it('clamps limit and honours approvedOnly', async () => {
        const { deps, calls } = makeDeps();
        await listLaunchpadCandidates(deps, { approvedOnly: true, limit: 9_999 }, ADMIN);
        await listLaunchpadCandidates(deps, { limit: 0.5 }, ADMIN);
        expect(calls.listCandidates).toEqual([
            { launchpad: 'stonkfun', approvedOnly: true, limit: 500 },
            { launchpad: 'stonkfun', approvedOnly: false, limit: 1 },
        ]);
    });

    it('rejects bad args', async () => {
        const { deps, calls } = makeDeps();
        for (const bad of [[], { launchpad: 'pumpfun' }, { approvedOnly: 'yes' }, { limit: 'ten' }]) {
            await expect(listLaunchpadCandidates(deps, bad, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        }
        expect(Object.keys(calls)).toHaveLength(0);
    });
});

describe('approveLaunchpadMint', () => {
    let logSpy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => {
        logSpy?.mockRestore();
        logSpy = null;
    });

    it('validates args (each failure is an InvalidArgsError, repo untouched)', async () => {
        const { deps, calls } = makeDeps();
        const bad: unknown[] = [
            [],
            {},
            { mint: 'not-a-mint' },
            { mint: 'O0Il' + 'a'.repeat(30) },
            { mint: MINT, note: 'x'.repeat(501) },
            { mint: MINT, note: 42 },
            { mint: MINT, launchpad: 'pumpfun' },
            { mint: MINT, quoteMint: 'not-a-mint' },
        ];
        for (const args of bad) {
            await expect(approveLaunchpadMint(deps, args, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        }
        expect(Object.keys(calls)).toHaveLength(0);
    });

    it('writes through the repo with the actor, trims the note, and logs the mutation', async () => {
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const { deps, calls } = makeDeps({ approve: { created: true, approvedAt: NOW } });
        const result = await approveLaunchpadMint(deps, { mint: ` ${MINT} `, note: '  team pick  ' }, ADMIN);
        expect(result).toEqual({ launchpad: 'stonkfun', mint: MINT, approved: true, created: true, approvedAt: NOW });
        expect(calls.approve).toEqual([
            {
                launchpad: 'stonkfun',
                mint: MINT,
                note: 'team pick',
                snapshot: { quoteMint: null, symbol: null, name: null, logoURI: null },
                actor: ADMIN,
                nowMs: NOW,
            },
        ]);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toEqual({
            event: 'mutation',
            mutation: 'approveLaunchpadMint',
            launchpad: 'stonkfun',
            mint: MINT,
            clerkUserId: 'admin_1',
            email: 'admin@example.com',
        });
    });

    it('passes the preview snapshot through (trimmed, non-http logo dropped)', async () => {
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const { deps, calls } = makeDeps();
        await approveLaunchpadMint(
            deps,
            {
                mint: MINT,
                quoteMint: ' Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re ',
                symbol: ' GP ',
                name: 'RuneScape Gold',
                logoURI: '/relative.png',
            },
            ADMIN,
        );
        expect((calls.approve![0] as { snapshot: unknown }).snapshot).toEqual({
            quoteMint: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re',
            symbol: 'GP',
            name: 'RuneScape Gold',
            logoURI: null,
        });
    });

    it('stores a null note for blank input and a null email for id-allowlisted admins', async () => {
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const { deps, calls } = makeDeps({ approve: { created: false, approvedAt: NOW - 5_000 } });
        const result = await approveLaunchpadMint(deps, { mint: MINT, note: '   ' }, { clerkUserId: 'admin_1' });
        expect(result.created).toBe(false);
        expect(result.approvedAt).toBe(NOW - 5_000);
        expect((calls.approve![0] as { note: string | null; actor: { email: string | null } }).note).toBeNull();
        expect((calls.approve![0] as { actor: { email: string | null } }).actor.email).toBeNull();
    });
});

describe('revokeLaunchpadMint', () => {
    let logSpy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => {
        logSpy?.mockRestore();
        logSpy = null;
    });

    it('revokes and logs', async () => {
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const { deps, calls } = makeDeps({ revoke: 'revoked' });
        expect(await revokeLaunchpadMint(deps, { mint: MINT }, ADMIN)).toEqual({
            launchpad: 'stonkfun',
            mint: MINT,
            revoked: true,
        });
        expect(calls.revoke).toEqual([{ launchpad: 'stonkfun', mint: MINT, actor: ADMIN, nowMs: NOW }]);
        expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('is a silent no-op when nothing was approved', async () => {
        logSpy = spyOn(console, 'log').mockImplementation(() => {});
        const { deps } = makeDeps({ revoke: 'not_found' });
        expect(await revokeLaunchpadMint(deps, { mint: MINT }, ADMIN)).toEqual({
            launchpad: 'stonkfun',
            mint: MINT,
            revoked: false,
        });
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('rejects a bad mint', async () => {
        const { deps, calls } = makeDeps();
        await expect(revokeLaunchpadMint(deps, { mint: 'nope' }, ADMIN)).rejects.toBeInstanceOf(InvalidArgsError);
        expect(Object.keys(calls)).toHaveLength(0);
    });
});
