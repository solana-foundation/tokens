import type { TokenMarketToken } from '@/lib/birdeye';

const POOL_PROTOCOL_LOGOS: Array<{ match: RegExp; icon: string }> = [
    { match: /orca/i, icon: 'https://www.orca.so/favicon.ico' },
    { match: /raydium|^ray$/i, icon: 'https://raydium.io/favicon.ico' },
    { match: /meteora|^met$/i, icon: 'https://www.meteora.ag/icons/v2.svg' },
    { match: /lifinity|lfinity|^lfnty$/i, icon: 'https://lifinity.io/favicon.ico' },
    { match: /byreal/i, icon: 'https://www.byreal.io/favicon.ico' },
    { match: /manifest/i, icon: '/logos/popular/manifest.svg' },
];

export function getPoolProtocolLogo(token: Pick<TokenMarketToken, 'symbol' | 'name' | 'address' | 'icon'> | undefined): string | undefined {
    const rawIcon = (token?.icon ?? '').trim();
    if (rawIcon) return rawIcon;

    const haystack = [token?.symbol, token?.name, token?.address]
        .map(value => (value ?? '').trim())
        .filter(Boolean)
        .join(' ');

    if (!haystack) return undefined;
    return POOL_PROTOCOL_LOGOS.find(entry => entry.match.test(haystack))?.icon;
}
