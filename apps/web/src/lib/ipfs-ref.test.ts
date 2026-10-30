import { describe, expect, test } from 'bun:test';

import { extractIpfsRef, proxiedIpfsLogoUrl, toIpfsUri } from './ipfs-ref';

const CID_V0 = 'QmZ7L8yd5j36oXXydUiYFiFsRHbi3EdgC4RuFwvM7dcqge';
const CID_V1 = 'bafkreibyb3hcn7gglvdqpmklfev3fut3eqv3kje54l3to3xzxxbgpt5wjm';

describe('extractIpfsRef', () => {
    test('parses raw ipfs:// refs with and without the ipfs/ prefix', () => {
        expect(extractIpfsRef(`ipfs://${CID_V1}`)).toEqual({ cid: CID_V1, path: '' });
        expect(extractIpfsRef(`ipfs://ipfs/${CID_V0}/logo.png?x=1`)).toEqual({ cid: CID_V0, path: '/logo.png' });
    });

    test('parses path-style and subdomain-style gateway URLs', () => {
        expect(extractIpfsRef(`https://ipfs.io/ipfs/${CID_V1}`)).toEqual({ cid: CID_V1, path: '' });
        expect(extractIpfsRef(`https://${CID_V1}.ipfs.nftstorage.link/`)).toEqual({ cid: CID_V1, path: '' });
        expect(extractIpfsRef(`https://foo.mypinata.cloud/ipfs/${CID_V0}/a/b.svg`)).toEqual({
            cid: CID_V0,
            path: '/a/b.svg',
        });
    });

    test('rejects non-IPFS and invalid CIDs', () => {
        expect(extractIpfsRef('https://cdn.ondo.finance/x.png')).toBeNull();
        expect(extractIpfsRef('ipfs://notacid')).toBeNull();
        expect(extractIpfsRef('')).toBeNull();
    });
});

describe('proxiedIpfsLogoUrl', () => {
    test('routes raw refs and public gateways through the image proxy', () => {
        const expected = `/api/image-proxy?src=${encodeURIComponent(`ipfs://${CID_V1}`)}`;
        expect(proxiedIpfsLogoUrl(`ipfs://${CID_V1}`)).toBe(expected);
        expect(proxiedIpfsLogoUrl(`https://ipfs.io/ipfs/${CID_V1}`)).toBe(expected);
        expect(proxiedIpfsLogoUrl(`https://${CID_V1}.ipfs.dweb.link`)).toBe(expected);
        expect(proxiedIpfsLogoUrl(`https://gateway.pinata.cloud/ipfs/${CID_V1}`)).toBe(expected);
    });

    test('leaves dedicated gateways and non-IPFS URLs alone', () => {
        expect(proxiedIpfsLogoUrl(`https://centrifuge.mypinata.cloud/ipfs/${CID_V0}`)).toBeNull();
        expect(proxiedIpfsLogoUrl('https://arweave.net/abc')).toBeNull();
        expect(proxiedIpfsLogoUrl('ipfs://bogus')).toBeNull();
    });
});

describe('toIpfsUri', () => {
    test('canonicalises to ipfs://<cid><path>', () => {
        expect(toIpfsUri(`https://ipfs.io/ipfs/${CID_V0}/logo.png`)).toBe(`ipfs://${CID_V0}/logo.png`);
        expect(toIpfsUri('https://example.com')).toBeNull();
    });
});
