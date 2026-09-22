import { describe, expect, test } from 'bun:test';

import {
    buildDirectAttempts,
    buildFetchPlan,
    extractIpfsRef,
    extractJupiterIcon,
    isFirstPartyLogoUrl,
    isPublicGatewayHost,
    isValidCid,
    sha256Hex,
} from './logoSource';

const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('isValidCid', () => {
    test('accepts v0 and v1 CIDs, rejects junk', () => {
        expect(isValidCid(CID_V0)).toBe(true);
        expect(isValidCid(CID_V1)).toBe(true);
        expect(isValidCid('Qm-not-a-cid')).toBe(false);
        expect(isValidCid('logo.png')).toBe(false);
        expect(isValidCid('')).toBe(false);
    });
});

describe('extractIpfsRef', () => {
    test('ipfs:// scheme, with and without the ipfs/ prefix and a sub-path', () => {
        expect(extractIpfsRef(`ipfs://${CID_V0}`)).toEqual({ cid: CID_V0, path: '' });
        expect(extractIpfsRef(`ipfs://ipfs/${CID_V0}/logo.png`)).toEqual({ cid: CID_V0, path: '/logo.png' });
        expect(extractIpfsRef(`ipfs://${CID_V1}/dir/icon.svg?x=1`)).toEqual({ cid: CID_V1, path: '/dir/icon.svg' });
    });

    test('public gateway path form keeps the sub-path and drops the query', () => {
        expect(extractIpfsRef(`https://ipfs.io/ipfs/${CID_V0}`)).toEqual({ cid: CID_V0, path: '' });
        expect(extractIpfsRef(`https://dweb.link/ipfs/${CID_V0}/logo.png?img-width=200`)).toEqual({
            cid: CID_V0,
            path: '/logo.png',
        });
        expect(extractIpfsRef(`https://nftstorage.link/ipfs/${CID_V1}/`)).toEqual({ cid: CID_V1, path: '' });
    });

    test('subdomain gateway form', () => {
        expect(extractIpfsRef(`https://${CID_V1}.ipfs.dweb.link/`)).toEqual({ cid: CID_V1, path: '' });
        expect(extractIpfsRef(`https://${CID_V1}.ipfs.w3s.link/token.png`)).toEqual({ cid: CID_V1, path: '/token.png' });
        expect(extractIpfsRef(`https://${CID_V1}.ipfs.nftstorage.link/a/b.jpg#frag`)).toEqual({
            cid: CID_V1,
            path: '/a/b.jpg',
        });
    });

    test('dedicated pinata gateway form', () => {
        expect(extractIpfsRef(`https://myproject.mypinata.cloud/ipfs/${CID_V0}?pinataGatewayToken=abc`)).toEqual({
            cid: CID_V0,
            path: '',
        });
    });

    test('non-IPFS and malformed inputs return null', () => {
        expect(extractIpfsRef('https://static.jup.ag/jup/icon.png')).toBeNull();
        expect(extractIpfsRef('https://ipfs.io/ipfs/not-a-cid')).toBeNull();
        expect(extractIpfsRef('ipfs://')).toBeNull();
        expect(extractIpfsRef('')).toBeNull();
        expect(extractIpfsRef('/logos/xstocks/TSLAx.png')).toBeNull();
        expect(extractIpfsRef('ftp://ipfs.io/ipfs/' + CID_V0)).toBeNull();
    });
});

describe('isPublicGatewayHost', () => {
    test('matches the measured Cloudflare-fronted gateways exactly and by subdomain', () => {
        for (const host of ['ipfs.io', 'dweb.link', 'w3s.link', 'nftstorage.link', 'cf-ipfs.com', 'gateway.pinata.cloud']) {
            expect(isPublicGatewayHost(host)).toBe(true);
        }
        expect(isPublicGatewayHost(`${CID_V1}.ipfs.dweb.link`)).toBe(true);
        expect(isPublicGatewayHost('IPFS.IO')).toBe(true);
    });

    test('does not match dedicated gateways or arbitrary hosts', () => {
        expect(isPublicGatewayHost('myproject.mypinata.cloud')).toBe(false);
        expect(isPublicGatewayHost('static.jup.ag')).toBe(false);
        expect(isPublicGatewayHost('notipfs.io')).toBe(false);
        expect(isPublicGatewayHost('')).toBe(false);
    });
});

describe('isFirstPartyLogoUrl', () => {
    const base = 'https://storage.googleapis.com/tokens-asset-logos-prd';
    test('local overrides, our hosts and the bucket are first-party', () => {
        expect(isFirstPartyLogoUrl('/logos/xstocks/TSLAx.png', base)).toBe(true);
        expect(isFirstPartyLogoUrl('https://api.tokens.xyz/logos/popular/tbtc-logo.png', base)).toBe(true);
        expect(isFirstPartyLogoUrl('https://tokens.xyz/logos/a.png', base)).toBe(true);
        expect(isFirstPartyLogoUrl(`${base}/solana/${MINT}.webp`, base)).toBe(true);
        expect(isFirstPartyLogoUrl('https://storage.googleapis.com/tokens-asset-logos-stg/logos/x/1.png')).toBe(true);
    });
    test('upstream hosts are not', () => {
        expect(isFirstPartyLogoUrl('https://static.jup.ag/jup/icon.png', base)).toBe(false);
        expect(isFirstPartyLogoUrl(`https://ipfs.io/ipfs/${CID_V0}`, base)).toBe(false);
        expect(isFirstPartyLogoUrl('', base)).toBe(false);
    });
});

describe('buildFetchPlan', () => {
    const cfg = { pinataGatewayHost: 'tokens.mypinata.cloud', pinataGatewayToken: 'tok' };

    test('IPFS on a public gateway: pinata, then dexscreener, then jupiter (origin skipped)', () => {
        const plan = buildFetchPlan(MINT, `https://ipfs.io/ipfs/${CID_V0}/logo.png`, cfg);
        expect(plan.map(a => a.source)).toEqual(['pinata', 'dexscreener', 'jupiter']);
        const pinata = plan[0]!;
        if (pinata.source !== 'pinata') throw new Error('expected pinata');
        expect(pinata.url).toBe(`https://tokens.mypinata.cloud/ipfs/${CID_V0}/logo.png`);
        expect(pinata.headers['x-pinata-gateway-token']).toBe('tok');
        const dex = plan[1]!;
        if (dex.source !== 'dexscreener') throw new Error('expected dexscreener');
        expect(dex.url).toBe(`https://dd.dexscreener.com/ds-data/tokens/solana/${MINT}.png`);
        const jup = plan[2]!;
        if (jup.source !== 'jupiter') throw new Error('expected jupiter');
        expect(jup.lookupUrl).toBe(`https://lite-api.jup.ag/tokens/v2/search?query=${MINT}`);
    });

    test('IPFS on a dedicated gateway: pinata first, then the dedicated origin', () => {
        const url = `https://other.mypinata.cloud/ipfs/${CID_V0}`;
        const plan = buildFetchPlan(MINT, url, cfg);
        expect(plan.map(a => a.source)).toEqual(['pinata', 'origin', 'dexscreener', 'jupiter']);
        const origin = plan[1]!;
        if (origin.source !== 'origin') throw new Error('expected origin');
        expect(origin.url).toBe(url);
    });

    test('ipfs:// scheme has no origin attempt', () => {
        const plan = buildFetchPlan(MINT, `ipfs://${CID_V0}`, cfg);
        expect(plan.map(a => a.source)).toEqual(['pinata', 'dexscreener', 'jupiter']);
    });

    test('public gateway without pinata configured: dexscreener first', () => {
        const plan = buildFetchPlan(MINT, `https://ipfs.io/ipfs/${CID_V0}`, {});
        expect(plan.map(a => a.source)).toEqual(['dexscreener', 'jupiter']);
    });

    test('plain https URL: origin first, no pinata', () => {
        const plan = buildFetchPlan(MINT, 'https://pyth.network/token.svg', cfg);
        expect(plan.map(a => a.source)).toEqual(['origin', 'dexscreener', 'jupiter']);
    });

    test('jupiter lookup template override', () => {
        const plan = buildFetchPlan(MINT, 'https://x.test/a.png', {
            jupiterTokenApiUrl: 'https://tokens.example/{mint}',
        });
        const jup = plan.at(-1)!;
        if (jup.source !== 'jupiter') throw new Error('expected jupiter');
        expect(jup.lookupUrl).toBe(`https://tokens.example/${MINT}`);
    });

    test('buildDirectAttempts never includes fallbacks', () => {
        expect(buildDirectAttempts(`https://ipfs.io/ipfs/${CID_V0}`, {})).toEqual([]);
        expect(buildDirectAttempts('https://cdn.example/a.png', cfg).map(a => a.source)).toEqual(['origin']);
    });
});

describe('extractJupiterIcon', () => {
    test('array payload, matched by id or address', () => {
        expect(extractJupiterIcon([{ id: 'other', icon: 'https://x/1.png' }, { id: MINT, icon: 'https://x/2.png' }], MINT)).toBe(
            'https://x/2.png',
        );
        expect(extractJupiterIcon([{ address: MINT, logoURI: 'https://x/3.png' }], MINT)).toBe('https://x/3.png');
    });
    test('wrapped and single-object payloads; missing icon returns null', () => {
        expect(extractJupiterIcon({ data: [{ id: MINT, icon: ' https://x/4.png ' }] }, MINT)).toBe('https://x/4.png');
        expect(extractJupiterIcon({ icon: 'https://x/5.png' }, MINT)).toBe('https://x/5.png');
        expect(extractJupiterIcon([{ id: MINT }], MINT)).toBeNull();
        expect(extractJupiterIcon(null, MINT)).toBeNull();
        expect(extractJupiterIcon('nope', MINT)).toBeNull();
    });
});

describe('sha256Hex', () => {
    test('is deterministic and hex', async () => {
        const a = await sha256Hex('https://example.test/a.png');
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(await sha256Hex('https://example.test/a.png')).toBe(a);
        expect(await sha256Hex('https://example.test/b.png')).not.toBe(a);
    });
});
