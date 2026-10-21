import { afterEach, describe, expect, test } from 'bun:test';

import { buildAllowedRemoteHosts, fetchWithValidatedRedirects, isAllowedRemoteHost } from './_remote-asset-fetch';

describe('remote asset host validation', () => {
    test('allows explicit Arweave gateway subdomains for validated redirects', () => {
        const allowedHosts = buildAllowedRemoteHosts();

        expect(
            isAllowedRemoteHost('a7brc3qelswhudc4dbhcsx2jpjxfvqq67botmo4a6lts24ozr5fq.arweave.net', allowedHosts),
        ).toBe(true);
    });

    test('does not treat suffix-like hostnames as trusted subdomains', () => {
        const allowedHosts = buildAllowedRemoteHosts();

        expect(isAllowedRemoteHost('not-arweave.net', allowedHosts)).toBe(false);
        expect(isAllowedRemoteHost('arweave.net.evil.example', allowedHosts)).toBe(false);
    });

    test('continues to block localhost and private IP hosts even when present in the allowlist', () => {
        const allowedHosts = new Set(['localhost', '127.0.0.1', '192.168.1.20']);

        expect(isAllowedRemoteHost('localhost', allowedHosts)).toBe(false);
        expect(isAllowedRemoteHost('127.0.0.1', allowedHosts)).toBe(false);
        expect(isAllowedRemoteHost('192.168.1.20', allowedHosts)).toBe(false);
    });

    test('allows the first-party logo hosts and no longer trusts public IPFS gateways', () => {
        const allowedHosts = buildAllowedRemoteHosts();

        expect(isAllowedRemoteHost('storage.googleapis.com', allowedHosts)).toBe(true);
        expect(isAllowedRemoteHost('img.tokens.xyz', allowedHosts)).toBe(true);
        expect(isAllowedRemoteHost('ipfs.io', allowedHosts)).toBe(false);
        expect(isAllowedRemoteHost('cf-ipfs.com', allowedHosts)).toBe(false);
        expect(isAllowedRemoteHost('dweb.link', allowedHosts)).toBe(false);
    });
});

describe('fetchWithValidatedRedirects', () => {
    const originalFetch = globalThis.fetch;

    function stubRedirectTo(location: string): { calls: string[] } {
        const calls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
            calls.push(String(input instanceof Request ? input.url : input));
            return new Response(null, { status: 302, headers: { location } });
        }) as typeof fetch;
        return { calls };
    }

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('rejects a redirect to a non-http(s) scheme before following it', async () => {
        const { calls } = stubRedirectTo('ftp://assets.coingecko.com/logo.png');

        await expect(
            fetchWithValidatedRedirects(
                new URL('https://assets.coingecko.com/start.png'),
                {},
                buildAllowedRemoteHosts(),
            ),
        ).rejects.toThrow('Unsupported protocol');
        expect(calls).toHaveLength(1);
    });

    test('rejects a redirect that carries credentials before following it', async () => {
        const { calls } = stubRedirectTo('https://user:pw@assets.coingecko.com/logo.png');

        await expect(
            fetchWithValidatedRedirects(
                new URL('https://assets.coingecko.com/start.png'),
                {},
                buildAllowedRemoteHosts(),
            ),
        ).rejects.toThrow('Credentials not allowed');
        expect(calls).toHaveLength(1);
    });

    test('rejects a redirect to a host outside the allowlist before following it', async () => {
        const { calls } = stubRedirectTo('https://evil.example/logo.png');

        await expect(
            fetchWithValidatedRedirects(
                new URL('https://assets.coingecko.com/start.png'),
                {},
                buildAllowedRemoteHosts(),
            ),
        ).rejects.toThrow('Host not allowed');
        expect(calls).toHaveLength(1);
    });
});
