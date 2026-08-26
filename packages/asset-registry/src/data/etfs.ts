import type { CanonicalAsset, TrustTier, VariantKind } from '../types';
import { CURATED_TOKEN_LISTS } from './curated-token-lists';
import { uniqueStrings } from '../utils/unique-strings';

interface EtfOverride {
    name: string;
    symbol?: string;
    kind?: VariantKind;
    trustTier?: TrustTier;
    aliases?: string[];
    coingeckoId?: string;
}

const ETF_OVERRIDES: Record<string, EtfOverride> = {
    // xStocks index tokens
    Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: { name: 'Nasdaq', coingeckoId: 'nasdaq-xstock' },
    XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: { name: 'SP500' },
    XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc: { name: 'TQQQ', kind: 'leveraged' },
    XsbELVbLGBkn7xfMfyYuUipKGt1iRUc2B7pYRvFTFu3: { name: 'Russell 2000' },
    XsFnZawJdLdXfBSEt5Vw29K5vdBiHotdPLjUPafpfHs: { name: 'Core MSCI EM' },
    XsWAnFM77x6YvpdaZoos79R12o4Yj4r7EVkaTWddzhU: { name: 'Schwab Intl' },
    XsssYEQjzxBCFgvYFFNuhJFBeHNdLWYeUSP8F45cDr9: { name: 'Vanguard' },
    XsEdDDTcVGJU6nvdRdVnj53eKTrsCkvtrVfXGmUK68V: { name: 'Vanguard Total World' },
    XsaQGz41BEQkS9xAB44uvUtuXcdLJAXEU1dogEzWMZ8: { name: 'Strategy PP Fixed' },
    Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH: { name: 'Strategy PP Variable' },

    // Ondo ETFs
    '916SDKz7y5ZcEZC9CtnQ5Djs1Y8Yv3UAPb6bak8ondo': { name: 'iShares MSCI Emerging Markets ETF' },
    AbvryMGnaba9oADMZk8Vp2Av6MtczsncGyfWaC4ondo: { name: 'iShares MSCI EAFE ETF' },
    C9J9vZ8N79GzzxFoRkPWCkGtMKU8akg4FhUk4r9ondo: { name: 'iShares Core MSCI EAFE ETF' },
    // Live metadata identifies this Ondo mint as IEMG, not IEFA; 'Core MSCI EM'
    // groups it with the xStocks IEMG tracker under core-msci-em.
    cdVNL7wK8mf1UCDqM6zdrziRv4hmvqWhXeTcck2ondo: { name: 'Core MSCI EM' },
    cfPLN9WXD2BTkbZhRZMVXPmVSiRo44hJWRtnaC8ondo: { name: 'iShares Core S&P MidCap ETF' },
    CPWkMURVvcnX8hGjqCTb8i5LkzV3VSvyk7SeJi8ondo: { name: 'iShares Core S&P Total US Stock Market ETF' },
    CqW2pd6dCPG9xKZfAsTovzDsMmAGKJSDBNcwM96ondo: { name: 'iShares Core S&P 500 ETF' },
    dSHPFuMMjZqt7xDYGWrexXTSkdEZAiZngqymQF2ondo: { name: 'iShares Russell 1000 Growth ETF' },
    dvj2kKFSyjpnyYSYppgFdAEVfgjMEoQGi9VaV23ondo: { name: 'iShares Russell 2000 ETF' },
    DX7g7WNjDpVzNK9CG81v7wb6ZbiNzYfkdzH2Xs5ondo: { name: 'iShares Russell 2000 Value ETF' },
    HrYNm6jTQ71LoFphjVKBTdAE4uja7WsmLG8VxB8ondo: { name: 'Invesco QQQ' },
    k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo: { name: 'SPDR S&P 500 ETF' },
    jCCU4GwukjNxAXJowG2S4KCrr5g6YyUB61WHYvGondo: { name: 'Vanguard Total Stock Market ETF' },
    D1tu7Fnm3cCpKyyPXrqm5GXShPqMj7a2SEjjq9fondo: { name: 'ProShares UltraPro Short QQQ', kind: 'leveraged' },
    '14W1itEkV7k1W819mLSknFTaMmkCtPokbF2tRkPUondo': { name: 'ProShares UltraPro QQQ', kind: 'leveraged' },
};

function slugify(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replaceAll('&', 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function fallbackEtfAssetId(mint: string): string {
    return `etf-${mint.slice(0, 8).toLowerCase()}`;
}

function defaultTrustTierForMint(_mint: string): TrustTier {
    return 'tier3';
}

export const ETF_ASSETS: CanonicalAsset[] = CURATED_TOKEN_LISTS.etfs.addresses.map(mint => {
    const override = ETF_OVERRIDES[mint];
    const assetId = override ? slugify(override.symbol ?? override.name) : fallbackEtfAssetId(mint);
    const kind: VariantKind = override?.kind ?? 'etf';
    const trustTier: TrustTier = override?.trustTier ?? defaultTrustTierForMint(mint);

    return {
        assetId,
        category: 'etf',
        ...(override ? { name: override.name, ...(override.symbol ? { symbol: override.symbol } : {}) } : {}),
        ...(override?.coingeckoId ? { coingeckoId: override.coingeckoId } : {}),
        aliases: uniqueStrings([
            assetId,
            mint,
            override?.coingeckoId ?? '',
            override?.symbol ?? '',
            override?.name ?? '',
            ...(override?.aliases ?? []),
        ]),
        variants: [
            {
                variantId: `${assetId}:${mint}`,
                mint,
                kind,
                trustTier,
                tags: ['curated:etfs'],
            },
        ],
    } satisfies CanonicalAsset;
});
