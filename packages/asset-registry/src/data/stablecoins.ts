import type { CanonicalAsset } from '../types';
import { CURRENCY_MINTS } from './list-mints';
import { uniqueStrings } from '../utils/unique-strings';

interface StablecoinOverride {
    name: string;
    symbol: string;
    coingeckoId?: string;
    aliases?: string[];
}

const STABLECOIN_OVERRIDES: Record<string, StablecoinOverride> = {
    AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9: { name: 'AUSD', symbol: 'AUSD' },
    A94X2fRy3wydNShU4dRaDyap2UuoeWJGWyATtyp61WZf: { name: 'BiLira', symbol: 'TRYB' },
    GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr: {
        name: 'BlackRock USD Institutional Digital Liquidity Fund',
        symbol: 'BUIDL',
        aliases: ['BUIDL'],
    },
    FtgGSFADXBtroxq8VCausXRr2of47QBf5AS1NtZCu4GD: { name: 'BRZ', symbol: 'BRZ' },
    CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: { name: 'CASH', symbol: 'CASH' },
    HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { name: 'EURC', symbol: 'EURC' },
    DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52: { name: 'EUR CoinVertible', symbol: 'EURCV' },
    '2VhjJ9WxaGC3EZFwJG9BDUs9KxKCAjQY4vgd1qxgYWVg': { name: 'EUROe Stablecoin', symbol: 'EUROe' },
    '9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u': { name: 'First Digital USD', symbol: 'FDUSD' },
    GGUSDyBUPFg5RrgWwqEqhXoha85iYGs6cL57SyK4G2Y7: { name: 'GGUSD', symbol: 'GGUSD' },
    '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': { name: 'Global Dollar', symbol: 'USDG' },
    Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g: { name: 'GMO JPY', symbol: 'GYEN' },
    idrxTdNftk6tYedPv2M7tCFHBVCpk5rkiNRd8yUArhr: { name: 'IDRX', symbol: 'IDRX' },
    '52GzcLDMfBveMRnWXKX7U3Pa5Lf7QLkWWvsJRDjWDBSk': { name: 'NGN Coin', symbol: 'NGNC' },
    A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6: { name: 'Ondo US Dollar Yield', symbol: 'USDY' },
    ZPFtoCe7WWqG4N3ZFRccS8T9SMBeHsd1Vmgv2i7ondo: {
        name: 'Ondo U.S. Dollar Token',
        symbol: 'USD',
        aliases: ['Ondo USD'],
    },
    HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM: { name: 'Pax Dollar', symbol: 'USDP' },
    APhcqtzE73es3KAGiVksZFMLGwJDiAey5qZKUrQHEHfS: { name: 'SoFi USD', symbol: 'SOFIUSD', aliases: ['SoFiUSD', 'SOFID'] },
    HVWf8JmLoHs99Lw8Psf3fyqAtA4crWxCPkrmSdNjhNH3: { name: 'U.S. Dollar Payment Token', symbol: 'USDPT' },
    '72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu': { name: 'USDtb', symbol: 'USDtb' },
    '8yXrtJ54jZtE84xEBzTESKuegjcAkAuDrdAhRd8i8n3T': { name: 'USDtb', symbol: 'USDtb' },
    '5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E': { name: 'Hylo USD', symbol: 'hyUSD', aliases: ['Hylo USD'] },
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { name: 'PayPal USD', symbol: 'PYUSD' },
    BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6: { name: 'Legacy USD Star', symbol: 'legacyUSD*' },
    star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM: { name: 'USD Star', symbol: 'USD*' },
    '6zYgzrT7X2wi9a9NeMtUvUWLLmf2a8vBsbYkocYdB9wa': { name: 'Real MXN', symbol: 'MXNe' },
    USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: { name: 'USDS', symbol: 'USDS' },
    susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X: { name: 'Solayer USD', symbol: 'sUSD' },
    AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: { name: 'Syrup USDC', symbol: 'syrupUSDC' },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { name: 'USDT', symbol: 'USDT' },
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { name: 'USD Coin', symbol: 'USDC' },
    DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT: { name: 'USDe', symbol: 'USDe' },
    '9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy': { name: 'USDu', symbol: 'USDu' },
    '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG': { name: 'USX', symbol: 'USX' },
    '2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW': {
        name: 'Tokenised GBP',
        symbol: 'tGBP',
        coingeckoId: 'tokenised-gbp',
        aliases: ['Tokenized GBP'],
    },
    '5H4voZhzySsVvwVYDAKku8MZGuYBC7cXaBKDPW4YHWW1': { name: 'VNX British Pound', symbol: 'VGBP' },
    C4Kkr9NZU3VbyedcgutU6LKmi6MKz81sx6gRmk5pX519: { name: 'VNX Euro', symbol: 'VEUR' },
    AhhdRu5YZdjVkKR3wbnUDaymVQL2ucjMQ63sZ3LFHsch: { name: 'VNX Swiss Franc', symbol: 'VCHF' },
    USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { name: 'World Liberty Financial USD', symbol: 'USD1' },
    dngKhBQM3BGvsDHKhrLnjvRKfY5Q7gEnYGToj9Lk8rk: { name: 'ZARP Stablecoin', symbol: 'ZARP' },
    JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: { name: 'Jupiter USD', symbol: 'jupUSD', aliases: ['JUPUSD'] },
    '71S9cppWipeUEQDFngYwxjoxB6Sz1MUqX72byLsVYJqy': { name: 'XSGD', symbol: 'XSGD' },
    '4UbvZiomFvXDnZSz6vdHiDNiHozH2ykTEqjhhbVHiv9z': { name: 'XUSD', symbol: 'XUSD' },
    myrcAs6bpP2g5oGHZ3qpgrfZQAFkbo9KUHdqYDXMjGv: { name: 'MYRC', symbol: 'MYRC' },
    AUDDttiEpCydTm7joUMbYddm72jAWXZnCpPZtDoxqBSw: { name: 'AUDD', symbol: 'AUDD' },
};

const USD_VARIANT_SYMBOLS = new Set<string>(
    [
        'USDC',
        'USD',
        'USDT',
        'FDUSD',
        'PYUSD',
        'USDY',
        'USDG',
        'USDS',
        'USDe',
        'AUSD',
        'USDP',
        'SOFIUSD',
        'USDPT',
        'GGUSD',
        'USD1',
        'USDu',
        'CASH',
        'USD*',
        'legacyUSD*',
        'sUSD',
        'syrupUSDC',
        'hyUSD',
        // NOTE: These are currently unreachable because `isUsdStableVariant` is only called when a
        // mint has an override in `STABLECOIN_OVERRIDES`. Uncomment when we add overrides for them.
        // 'ZUSD',
        'USDtb',
        // 'DUSD',
        // 'USDGO',
        // 'USDU',
        // 'USDCV',
        // 'SBC',
        // 'FRNT',
        'USX',
        'jupUSD',
        'XUSD',
    ].map(value => value.trim().toLowerCase()),
);

const USD_YIELD_VARIANT_SYMBOLS = new Set<string>(
    ['USDY', 'USD*', 'legacyUSD*', 'sUSD', 'syrupUSDC'].map(value => value.trim().toLowerCase()),
);

const EUR_VARIANT_SYMBOLS = new Set<string>(
    ['EURC', 'EURCV', 'EUROe', 'VEUR'].map(value => value.trim().toLowerCase()),
);

const EUR_YIELD_VARIANT_SYMBOLS = new Set<string>();

function slugFromSymbol(symbol: string): string {
    return symbol
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function fallbackStablecoinAssetId(mint: string): string {
    return `stable-${mint.slice(0, 8).toLowerCase()}`;
}

function isUsdStableVariant(override: StablecoinOverride | undefined): boolean {
    const key = (override?.symbol ?? '').trim().toLowerCase();
    if (!key) return false;
    return USD_VARIANT_SYMBOLS.has(key);
}

function isEurStableVariant(override: StablecoinOverride | undefined): boolean {
    const key = (override?.symbol ?? '').trim().toLowerCase();
    if (!key) return false;
    return EUR_VARIANT_SYMBOLS.has(key);
}

function usdVariantKind(override: StablecoinOverride): CanonicalAsset['variants'][number]['kind'] {
    const symbolKey = override.symbol.trim().toLowerCase();
    return USD_YIELD_VARIANT_SYMBOLS.has(symbolKey) ? 'yield' : 'native';
}

function eurVariantKind(override: StablecoinOverride): CanonicalAsset['variants'][number]['kind'] {
    const symbolKey = override.symbol.trim().toLowerCase();
    return EUR_YIELD_VARIANT_SYMBOLS.has(symbolKey) ? 'yield' : 'native';
}

export const STABLECOIN_ASSETS: CanonicalAsset[] = (() => {
    const standaloneAssets: CanonicalAsset[] = [];
    const usdVariants: CanonicalAsset['variants'] = [];
    const usedUsdVariantSuffixes = new Set<string>();
    const eurVariants: CanonicalAsset['variants'] = [];
    const usedEurVariantSuffixes = new Set<string>();

    for (const mint of CURRENCY_MINTS) {
        const override = STABLECOIN_OVERRIDES[mint];

        if (override && isUsdStableVariant(override)) {
            const baseSuffix = override.symbol ? slugFromSymbol(override.symbol) : mint.slice(0, 8).toLowerCase();
            const suffix = (() => {
                if (!usedUsdVariantSuffixes.has(baseSuffix)) {
                    usedUsdVariantSuffixes.add(baseSuffix);
                    return baseSuffix;
                }
                const fallback = `${baseSuffix}-${mint.slice(0, 8).toLowerCase()}`;
                usedUsdVariantSuffixes.add(fallback);
                return fallback;
            })();

            usdVariants.push({
                variantId: `usd:${suffix}`,
                mint,
                kind: usdVariantKind(override),
                trustTier: 'tier3',
                tags: ['curated:currencies'],
                ...(override ? { name: override.name, symbol: override.symbol } : {}),
            });
            continue;
        }

        if (override && isEurStableVariant(override)) {
            const baseSuffix = override.symbol ? slugFromSymbol(override.symbol) : mint.slice(0, 8).toLowerCase();
            const suffix = (() => {
                if (!usedEurVariantSuffixes.has(baseSuffix)) {
                    usedEurVariantSuffixes.add(baseSuffix);
                    return baseSuffix;
                }
                const fallback = `${baseSuffix}-${mint.slice(0, 8).toLowerCase()}`;
                usedEurVariantSuffixes.add(fallback);
                return fallback;
            })();

            eurVariants.push({
                variantId: `eur:${suffix}`,
                mint,
                kind: eurVariantKind(override),
                trustTier: 'tier3',
                tags: ['curated:currencies'],
                ...(override ? { name: override.name, symbol: override.symbol } : {}),
            });
            continue;
        }

        const assetId = override?.symbol ? slugFromSymbol(override.symbol) : fallbackStablecoinAssetId(mint);

        standaloneAssets.push({
            assetId,
            category: 'stablecoin',
            ...(override ? { name: override.name, symbol: override.symbol } : {}),
            ...(override?.coingeckoId ? { coingeckoId: override.coingeckoId } : {}),
            aliases: uniqueStrings([
                assetId,
                mint,
                override?.symbol ?? '',
                override?.name ?? '',
                override?.coingeckoId ?? '',
                ...(override?.aliases ?? []),
            ]),
            variants: [
                {
                    variantId: `${assetId}:mint`,
                    mint,
                    kind: 'stablecoin',
                    trustTier: 'tier3',
                    tags: ['curated:currencies'],
                    ...(override ? { name: override.name, symbol: override.symbol } : {}),
                },
            ],
        } satisfies CanonicalAsset);
    }

    const aggregateAssets: CanonicalAsset[] = [];

    if (usdVariants.length > 0) {
        aggregateAssets.push({
            assetId: 'usd',
            name: 'US Dollar',
            symbol: 'USD',
            category: 'stablecoin',
            aliases: uniqueStrings([
                'usd',
                'USD',
                'US Dollar',
                ...usdVariants.flatMap(v => [v.mint, v.symbol ?? '', v.name ?? '', v.label ?? '', v.variantId]),
            ]),
            variants: usdVariants,
        });
    }

    if (eurVariants.length > 0) {
        aggregateAssets.push({
            assetId: 'eur',
            name: 'Euro',
            symbol: 'EUR',
            category: 'stablecoin',
            aliases: uniqueStrings([
                'eur',
                'EUR',
                'Euro',
                ...eurVariants.flatMap(v => [v.mint, v.symbol ?? '', v.name ?? '', v.label ?? '', v.variantId]),
            ]),
            variants: eurVariants,
        });
    }

    return aggregateAssets.length > 0 ? [...aggregateAssets, ...standaloneAssets] : standaloneAssets;
})();
