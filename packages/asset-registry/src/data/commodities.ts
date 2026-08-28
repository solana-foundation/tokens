import type { CanonicalAsset } from '../types';
import { METALS_MINTS as METALS_LIST_MINTS, STOCKS_MINTS as STOCKS_LIST_MINTS } from './list-mints';

// Mints in the `metals` list currently represent multiple underlying assets (gold, silver, etc).
// We group them here into canonical assets to enable centralized pages like `/gold`.

const ONDO_ISSUER = {
    issuer: 'Ondo',
    issuerUrl: 'https://ondo.finance',
} as const;

const MATRIXDOCK_ISSUER = {
    issuer: 'Matrixdock',
    issuerUrl: 'https://www.matrixdock.com',
} as const;

const PAXOS_ISSUER = {
    issuer: 'Paxos',
    issuerUrl: 'https://www.paxos.com',
} as const;

const METALS_MINTS = {
    tetherGold: 'AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P',
    goldSilverBasket: '9TPL8droGJ7jThsq4momaoz6uhTcvX2SeMqipoPmNa8R',
    gold1: 'GoLDppdjB1vDTPSGxyMJFqdnj134yH6Prg9eqsGDiw6A',
    gold2: 'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re',
    matrixdockGold: '5aLhp9VnUEKcsdtkfsf2DUgpJfomx7GmYVny24dHUZoB',
    paxGold: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW',
    ondoIsharesGold: 'M77ZvkZ8zW5udRbuJCbuwSwavRa7bGAZYMTwru8ondo',
    ondoIsharesSilver: 'iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo',
    ondoSpdrGold: 'hWfiw4mcxT8rnNFkk6fsCQSxoxgZ9yVhB6tyeVcondo',
    ondoCopperMiners: 'X7j77hTmjZJbepkXXBcsEapM8qNgdfihkFj6CZ5ondo',
} as const;

const OIL_MINTS = {
    ondoUso: 'rpydAzWdCy85HEmoQkH5PVxYtDYQWjmLxgHHadxondo',
} as const;

const COMMODITY_ASSETS_RAW: CanonicalAsset[] = [
    {
        assetId: 'gold',
        name: 'Gold',
        symbol: 'GLD',
        category: 'commodity',
        aliases: [
            'gold',
            'gld',
            'xau',
            'xaut',
            'xaum',
            'matrixdock-gold',
            'paxg',
            'pax-gold',
            'paxos-gold',
            'CdxPHbQjNbxyaDBjA92Bbka3YFC9t3JVyQ2cA1mSbNBR',
            'tether-gold',
            'gold-etf',
        ],
        variants: [
            {
                variantId: 'gold:tether-gold',
                mint: METALS_MINTS.tetherGold,
                kind: 'spot',
                trustTier: 'tier3',
                tags: ['gold', 'tether', 'xaut', 'curated:metals'],
                label: 'Tether Gold',
                issuer: 'Tether',
                issuerUrl: 'https://tether.to',
            },
            {
                variantId: 'gold:gold',
                mint: METALS_MINTS.gold1,
                kind: 'spot',
                trustTier: 'tier3',
                tags: ['gold', 'curated:metals'],
                label: 'GOLD',
            },
            {
                // Tracks the GLD ETF share price (~1/10 oz), not spot gold — categorized as `etf`.
                variantId: 'gold:gold-token',
                mint: METALS_MINTS.gold2,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['gold', 'etf', 'curated:metals'],
                label: 'Gold',
            },
            {
                variantId: 'gold:matrixdock-gold',
                mint: METALS_MINTS.matrixdockGold,
                symbol: 'XAUM',
                name: 'Matrixdock Gold',
                kind: 'spot',
                trustTier: 'tier3',
                tags: ['gold', 'matrixdock', 'xaum', 'curated:metals'],
                label: 'Matrixdock Gold',
                ...MATRIXDOCK_ISSUER,
            },
            {
                variantId: 'gold:pax-gold',
                mint: METALS_MINTS.paxGold,
                symbol: 'PAXG',
                name: 'PAX Gold',
                kind: 'spot',
                trustTier: 'tier3',
                tags: ['gold', 'paxos', 'paxg', 'curated:metals'],
                label: 'PAX Gold',
                ...PAXOS_ISSUER,
            },
            {
                variantId: 'gold:ondo-ishares-gold-trust',
                mint: METALS_MINTS.ondoIsharesGold,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['gold', 'etf', 'ondo', 'ishares', 'curated:metals'],
                label: 'iShares Gold Trust (Ondo)',
                ...ONDO_ISSUER,
            },
            {
                variantId: 'gold:ondo-spdr-gold-shares',
                mint: METALS_MINTS.ondoSpdrGold,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['gold', 'etf', 'ondo', 'spdr', 'curated:metals'],
                label: 'SPDR Gold Shares (Ondo)',
                ...ONDO_ISSUER,
            },
        ],
    },
    {
        assetId: 'silver',
        name: 'Silver',
        symbol: 'SLV',
        category: 'commodity',
        aliases: ['silver', 'xag', 'slv', 'silver-etf', 'ishares-silver-trust'],
        variants: [
            {
                variantId: 'silver:ondo-ishares-silver-trust',
                mint: METALS_MINTS.ondoIsharesSilver,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['silver', 'etf', 'ondo', 'ishares', 'curated:metals'],
                label: 'iShares Silver Trust (Ondo)',
                ...ONDO_ISSUER,
            },
        ],
    },
    {
        assetId: 'copper',
        name: 'Copper',
        symbol: 'COPPER',
        category: 'commodity',
        aliases: ['copper', 'copper-etf'],
        variants: [
            {
                variantId: 'copper:ondo-globalx-copper-miners',
                mint: METALS_MINTS.ondoCopperMiners,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['copper', 'etf', 'ondo', 'globalx', 'curated:metals'],
                label: 'Global X Copper Miners ETF (Ondo)',
                ...ONDO_ISSUER,
            },
        ],
    },
    {
        assetId: 'oil',
        name: 'Oil',
        symbol: 'USO',
        category: 'commodity',
        // Old equity slug + xStock group id kept as aliases so existing links keep resolving
        // (the equity asset is suppressed in equities.ts — promoted to this commodity).
        aliases: [
            'oil',
            'wti',
            'uso',
            'crude',
            'crude-oil',
            'united-states-oil-fund',
            'xstock-united-states-oil-fund',
            'united states oil fund',
        ],
        variants: [
            {
                variantId: 'oil:ondo-united-states-oil-fund',
                mint: OIL_MINTS.ondoUso,
                kind: 'etf',
                trustTier: 'tier3',
                tags: ['oil', 'etf', 'ondo', 'curated:stocks'],
                label: 'United States Oil Fund (Ondo)',
                ...ONDO_ISSUER,
            },
        ],
    },
    {
        assetId: 'precious-metals',
        name: 'Precious Metals',
        symbol: 'METALS',
        category: 'commodity',
        aliases: ['metals', 'precious-metals', 'gold-silver', 'basket'],
        variants: [
            {
                variantId: 'precious-metals:gold-silver-basket',
                mint: METALS_MINTS.goldSilverBasket,
                kind: 'basket',
                trustTier: 'tier3',
                tags: ['gold', 'silver', 'basket', 'curated:metals'],
                label: 'Gold/Silver Basket',
            },
        ],
    },
];

// Safety: keep COMMODITY_ASSETS consistent with the curated lists.
// (If the curated lists change, this prevents silently serving stale mints.)
// Oil's USO mint lives in the `stocks` curated list rather than `metals`.
const ALLOWED_COMMODITY_MINTS = new Set<string>([
    ...METALS_LIST_MINTS,
    ...STOCKS_LIST_MINTS,
]);

export const COMMODITY_ASSETS: CanonicalAsset[] = COMMODITY_ASSETS_RAW.filter(asset =>
    asset.variants.every(v => ALLOWED_COMMODITY_MINTS.has(v.mint)),
);
