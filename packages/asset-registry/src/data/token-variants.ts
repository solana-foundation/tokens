import { XSTOCK_VARIANT_GROUPS } from './xstock-variant-groups';
import { CURATED_TOKEN_LISTS } from './curated-token-lists';
import { STABLECOIN_ASSETS } from './stablecoins';

export { XSTOCK_VARIANT_GROUPS };

export interface TokenVariantAddress {
    address: string;
    label?: string;
}

export interface TokenVariantGroup {
    id: string;
    label: string;
    addresses: TokenVariantAddress[];
}

export const BITCOIN_VARIANT_GROUP: TokenVariantGroup = {
    id: 'bitcoin',
    label: 'Bitcoin variants',
    addresses: [
        { address: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh' },
        { address: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', label: 'cbBTC' },
        { address: 'CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn' },
        { address: 'zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg', label: 'zBTC' },
        { address: '5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ' },
        { address: '6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU' },
        { address: '9hX59xHHnaZXLU6quvm5uGY2iDiT3jczaReHy6A6TYKw' },
        { address: '21BTCo9hWHjGYYUQQLqjLgDBxjcn8vDt4Zic7TB3UbNE' },
        { address: 'upBTCBNCis2uHqFdCg2vFACLhkJ3NKwYbC4k8xbHjj4', label: 'upBTC' }, // Manifest Destiny BTC vault
    ],
};

export const GOLD_VARIANT_GROUP: TokenVariantGroup = {
    id: 'gold',
    label: 'Gold variants',
    addresses: [
        { address: 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P', label: 'XAUT (Tether Gold)' },
        { address: 'GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A', label: 'GOLD' },
        { address: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', label: 'Gold' },
        { address: 'M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo', label: 'iShares Gold (Ondo)' },
        { address: 'hWfiw4mcxT8rnNFkk6fsCQSxoxgZ9yVhB6tyeVcondo', label: 'SPDR Gold (Ondo)' },
    ],
};

function getUsdVariantAddresses(): TokenVariantAddress[] {
    const usd = STABLECOIN_ASSETS.find(asset => asset.assetId === 'usd');
    if (!usd) return [];

    return usd.variants.map(variant => ({
        address: variant.mint,
        ...(variant.symbol ? { label: variant.symbol } : {}),
    }));
}

export const USD_VARIANT_GROUP: TokenVariantGroup = {
    id: 'usd',
    label: 'US Dollar variants',
    addresses: getUsdVariantAddresses(),
};

function getEurVariantAddresses(): TokenVariantAddress[] {
    const eur = STABLECOIN_ASSETS.find(asset => asset.assetId === 'eur');
    if (!eur) return [];

    return eur.variants.map(variant => ({
        address: variant.mint,
        ...(variant.symbol ? { label: variant.symbol } : {}),
    }));
}

export const EUR_VARIANT_GROUP: TokenVariantGroup = {
    id: 'eur',
    label: 'Euro variants',
    addresses: getEurVariantAddresses(),
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const SOLANA_VARIANT_GROUP: TokenVariantGroup = {
    id: 'solana',
    label: 'Solana variants',
    addresses: [{ address: SOL_MINT }, ...CURATED_TOKEN_LISTS.lsts.addresses.map(address => ({ address }))],
};

export const TOKEN_VARIANT_GROUPS: TokenVariantGroup[] = [
    SOLANA_VARIANT_GROUP,
    USD_VARIANT_GROUP,
    EUR_VARIANT_GROUP,
    BITCOIN_VARIANT_GROUP,
    GOLD_VARIANT_GROUP,
    ...XSTOCK_VARIANT_GROUPS,
];

const TOKEN_VARIANT_GROUP_BY_ADDRESS = new Map<string, TokenVariantGroup>();
const TOKEN_VARIANT_GROUP_BY_ID = new Map<string, TokenVariantGroup>();

for (const group of TOKEN_VARIANT_GROUPS) {
    TOKEN_VARIANT_GROUP_BY_ID.set(group.id, group);
    for (const item of group.addresses) {
        TOKEN_VARIANT_GROUP_BY_ADDRESS.set(item.address, group);
    }
}

export function getTokenVariantGroup(address: string): TokenVariantGroup | null {
    return TOKEN_VARIANT_GROUP_BY_ADDRESS.get(address) ?? null;
}

export function getTokenVariantGroupById(id: string): TokenVariantGroup | null {
    return TOKEN_VARIANT_GROUP_BY_ID.get(id) ?? null;
}
