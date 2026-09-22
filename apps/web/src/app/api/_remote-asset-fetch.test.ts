import { describe, expect, test } from 'bun:test';

import { buildAllowedRemoteHosts, isAllowedRemoteHost } from './_remote-asset-fetch';

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
