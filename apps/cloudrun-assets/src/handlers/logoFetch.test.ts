import { describe, expect, test } from 'bun:test';

import { assertResolvesPublic, fetchLogoBytes, isBlockedLogoAddress, isBlockedLogoHost } from './logoFetch';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);

function fetchOk(calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
}

describe('isBlockedLogoAddress', () => {
    test('blocks loopback, RFC1918, link-local (metadata), CGNAT, multicast', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255']) {
            expect(isBlockedLogoAddress(ip)).toBe(true);
        }
    });
    test('blocks IPv6 loopback, unique-local, link-local, mapped-private and NAT64', () => {
        for (const ip of ['::1', '::', 'fd12:3456::1', 'fc00::1', 'fe80::1%eth0'.split('%')[0]!, '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1']) {
            expect(isBlockedLogoAddress(ip)).toBe(true);
        }
    });
    test('allows public addresses', () => {
        for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:93.184.216.34']) {
            expect(isBlockedLogoAddress(ip)).toBe(false);
        }
    });
    test('rejects garbage', () => {
        expect(isBlockedLogoAddress('')).toBe(true);
        expect(isBlockedLogoAddress('not-an-ip')).toBe(true);
    });
});

describe('isBlockedLogoHost', () => {
    test('hostname-text denylist', () => {
        expect(isBlockedLogoHost('localhost')).toBe(true);
        expect(isBlockedLogoHost('metadata.google.internal')).toBe(true);
        expect(isBlockedLogoHost('printer.local')).toBe(true);
        expect(isBlockedLogoHost('[::1]')).toBe(true);
        expect(isBlockedLogoHost('10.0.0.1')).toBe(true);
        expect(isBlockedLogoHost('cdn.example.com')).toBe(false);
    });
});

describe('assertResolvesPublic', () => {
    test('rejects when any resolved address is private', async () => {
        const out = await assertResolvesPublic('evil.example', async () => ['93.184.216.34', '169.254.169.254']);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.message).toContain('169.254.169.254');
    });
    test('accepts all-public resolution and IPv4 literals', async () => {
        expect((await assertResolvesPublic('cdn.example', async () => ['93.184.216.34'])).ok).toBe(true);
        expect((await assertResolvesPublic('93.184.216.34', async () => { throw new Error('should not resolve literals'); })).ok).toBe(true);
    });
    test('reports lookup failures and empty results', async () => {
        expect((await assertResolvesPublic('nx.example', async () => { throw new Error('ENOTFOUND'); })).ok).toBe(false);
        expect((await assertResolvesPublic('nx.example', async () => [])).ok).toBe(false);
    });
});

describe('fetchLogoBytes host validation', () => {
    test('never sends the request when the host resolves to a private address', async () => {
        const calls: string[] = [];
        const out = await fetchLogoBytes('https://logo.attacker.example/a.png', {
            provider: 'test',
            timeoutMs: 1000,
            fetchImpl: fetchOk(calls),
            resolveHost: async () => ['10.0.0.5'],
        });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('blocked_host');
        expect(calls).toEqual([]);
    });

    test('re-validates the resolved address on every redirect hop', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            calls.push(url);
            if (url.startsWith('https://public.example/')) {
                return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/computeMetadata/v1/' } });
            }
            return new Response(PNG, { status: 200 });
        }) as unknown as typeof fetch;
        const out = await fetchLogoBytes('https://public.example/a.png', {
            provider: 'test',
            timeoutMs: 1000,
            fetchImpl,
            resolveHost: async () => ['93.184.216.34'],
        });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('blocked_host');
        expect(calls).toEqual(['https://public.example/a.png']);
    });

    test('dns failure is a network failure, not a block', async () => {
        const calls: string[] = [];
        const out = await fetchLogoBytes('https://nx.example/a.png', {
            provider: 'test',
            timeoutMs: 1000,
            fetchImpl: fetchOk(calls),
            resolveHost: async () => {
                throw new Error('ENOTFOUND');
            },
        });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toBe('network');
        expect(calls).toEqual([]);
    });

    test('public host fetches normally', async () => {
        const calls: string[] = [];
        const out = await fetchLogoBytes('https://cdn.example/a.png', {
            provider: 'test',
            timeoutMs: 1000,
            fetchImpl: fetchOk(calls),
            resolveHost: async () => ['93.184.216.34'],
        });
        expect(out.ok).toBe(true);
        expect(calls).toEqual(['https://cdn.example/a.png']);
    });
});
