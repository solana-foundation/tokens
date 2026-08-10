import type { AssetVariant, CanonicalAsset, TrustTier } from '../types';
import { XSTOCK_VARIANT_GROUPS } from './token-variants';
import { ONDO_STOCK_MINTS_20260618 } from './ondo-stock-mints';
import { uniqueStrings } from '../utils/unique-strings';

const EQUITY_TICKER_BY_SLUG: Record<string, string> = {
    alphabet: 'GOOGL',
    amazon: 'AMZN',
    amd: 'AMD',
    apple: 'AAPL',
    'bending-spoons': 'BSP',
    circle: 'CRCL',
    coinbase: 'COIN',
    intel: 'INTC',
    meta: 'META',
    microsoft: 'MSFT',
    microstrategy: 'MSTR',
    micron: 'MU',
    nvidia: 'NVDA',
    robinhood: 'HOOD',
    'roundhill-memory-etf': 'DRAM',
    sandisk: 'SNDK',
    'sk-hynix': 'SKHY',
    spacex: 'SPCX',
    'spdr-gold-shares': 'GLD',
    'take-two-interactive': 'TTWO',
    tesla: 'TSLA',
    'invesco-qqq': 'QQQ',
};

const SPACEX_PRESTOCK_MINT = 'PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh';
const SPACEX_TSPX_MINT = 'TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v';
const SPACEX_ONDO_MINT = 'wzAyQTorWyoVXuJKj2x8EqKEGJpS13z6EWE9z5Aondo';
const SPACEX_BACKPACK_MINT = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
const SPACEX_XSTOCK_MINT = 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8';
const OPENAI_PRESTOCK_MINT = 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF';
const OPENAI_TESSERA_MINT = 'oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ';
const DRAM_ONDO_MINT = 'oXeD5ZesXfJQ3mxtuZdMaccUsWrE8r1SnpYRP2Bondo';
const DRAM_BACKPACK_MINT = 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw';
const SK_HYNIX_BACKPACK_MINT = 'SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3';
const SK_HYNIX_ONDO_MINT = 'Huyb2fyDDjSuDKCRWsN9ci2rmcgPo6NFiLbx9ZDondo';
const SK_HYNIX_XSTOCK_MINT = 'XsnhgGRQwhExfS2bmWzR6EYddKGPRGDEjeJsatkmKqU';
const TAKE_TWO_BACKPACK_MINT = 'TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo';

const ANTHROPIC_PRESTOCK_MINT = 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw';
const ANDURIL_PRESTOCK_MINT = 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB';
const POLYMARKET_PRESTOCK_MINT = 'Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP';
const KALSHI_PRESTOCK_MINT = 'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua';

const PRE_STOCK_MINTS: string[] = [
    SPACEX_PRESTOCK_MINT,
    OPENAI_PRESTOCK_MINT,
    ANTHROPIC_PRESTOCK_MINT,
    ANDURIL_PRESTOCK_MINT,
    POLYMARKET_PRESTOCK_MINT,
    KALSHI_PRESTOCK_MINT,
];

/**
 * Display metadata for PreStocks mints that are not promoted to a hand-curated asset.
 *
 * Without this, `buildPreStockAssets` emits a canonical entry carrying only an address, so a
 * consumer comparing a candidate mint against the canonical one has nothing to compare but the
 * address itself. SpaceX and OpenAI already avoid this by being fully described above.
 */
const PRE_STOCK_METADATA: Record<string, { symbol: string; name: string }> = {
    [ANTHROPIC_PRESTOCK_MINT]: { symbol: 'ANTHROPIC', name: 'Anthropic PreStocks' },
    [ANDURIL_PRESTOCK_MINT]: { symbol: 'ANDURIL', name: 'Anduril PreStocks' },
    [POLYMARKET_PRESTOCK_MINT]: { symbol: 'POLYMARKET', name: 'Polymarket PreStocks' },
    [KALSHI_PRESTOCK_MINT]: { symbol: 'KALSHI', name: 'Kalshi PreStocks' },
};

const UNLISTED_STOCK_MINTS: string[] = [
    'B5KufqHkskgGYwMXtL8FSHgREAkMQvE3ykhH5Kmondo',
    'B6WqvLGXdGqpw7qgxeb5EGiRZEYo2apWpQybjYuondo',
    'B6ry9goGNvVbhq7gWHzs3p6emJ1gLaMhu4By9TTondo',
    'BAU83kqEqhyiexfAMQhZZE5KnGogSqh17fJc44Sondo',
    'BS8zoc6pmALQnBhBDFak6eFhgGHjpebnHzsxApgondo',
    'BVdL3WUxtxUD4vXRWwqChJLbGxvfzZjBGPp63Wtondo',
    'BXMkru8ded26p71gJ3AMMwJmwZaYYfQjRo8vbZzondo',
    'BfPGpgNyxe6rjAru1EJarjSBAcCABuMF5L32v7nondo',
    'BmXVAFyfpW7VuVYeWDtbFtLx7sek2mZt3BEsGgAondo',
    'BncvtBGs4JqgYZwUoq3EN9q9HUFqJKTfWpvCsHCondo',
    'Bp26APthMuM46gMFTo5KYpo7b92GN2xSCor7f9oondo',
    'LitNUakTges74cjDJm6HHfFNKGPdySkp3MWSYzYondo',
    'BpYiU1dBXU1fdB64jbR93wHEw3Y47QeRLZvUyLQondo',
    'C6c7VcxuUYcV5YTsky5HM4PUmfwHTwsDD5DNwwPondo',
    'C8pSaSgjkiTWixS3GM6Hxd6HKnKrgAbY9WDgfVeondo',
    'CBKcmEvVg5EgE3W5hVSPcBYWh6TFVjQwbmYod9Pondo',
    'CJRoTbu98waCCuLFfLuJ2kXawLk889fqW4UAAbwondo',
    'CY8ttw5rYCT6fFBJwqXofefqa7Ji9E8zfLmhRLmondo',
    'CYAwMGyuNSDu7NpuccNwcxMNS5Bu9akxU2Jooyiondo',
    'CYqLHM92EhmF83iNgfN4A1j2ckjsHigRvXu7xHCondo',
    'CZ3FxxSto7tsjkSkqMek1C5p3RCFFmkwKqW57nbondo',
    'CZ9GBn1okotqKNUUqoxk4PF2JVi59bw5GWvVo6Dondo',
    'BJhPr9SM7uZTZXHeSLYmUk7CjGQq1esFkVxPF5tondo',
    'CeFbGYXDmkyfo1TXXzzZ512mtnCCewNohu6V15vondo',
    'CgZSv89BL58ybWfWobANKEU8nV9jYfFw23G2DZEondo',
    'CgnZbDNzBfaLyJqUtd4esKLShRp7RznQuwP4uQaondo',
    'CkWmEM2J79k6AjAwyQVHXteFucAL1zQrKLxLqJHondo',
    'CsN1Tyz467bSFLPGd6MJyZhPNtwDaWZtX8ixHWyondo',
    '6JLG8iUkAuqiBhL3j2ckDMDf5oWAa6awmyaWezKondo',
    'D4uWxzR5StYC6sTRhVts8Eboy3pmVtHeNC62dnQondo',
    'D8KT4Jd8qiKKTfkM8ejSKCpWGR1o3GFvnQGp5ERondo',
    'DBNwt3FoYCKQWdfzxKFNZ4mzuz4Jz1iRzFf7HFzondo',
    'DDZQijTbaSd3Kas1r1bgCnHPayk8vTP8SfZWp5Tondo',
    'DDcAL93Urf7KrPntvKULnZoFs4Wdee1LkkJqLpjondo',
    'DVPSYdqWPLvNa8afnEqa3B9eDfTTWpGyUZeXvdMondo',
    'DiDWPZ7vQXfpaeQ8BX68XuDYeiQLv7diDxdeUpaondo',
    'DiRshqNDE68bWbGdLHm1GwQ76MvWQG3af6w1NdQondo',
    'Dig28Tf1ufhCBAsjTmFkXCgcNgMqDMYj5A2rDQmondo',
    'Dm6FpQ76SsbVmAZ4NvD2mjZP7cxbw1CASr4WwCiondo',
    'DnvbCqRuUYssmKVRBRNwkUnptHitH4ZZTt1KVuZondo',
    'DsLQ18ooPjiHYuiuQ5Jz8PNCpVaKe3FhAYpvMxWondo',
    'DwRtkbsaQMGAS3oMeEGYh6M5vH4X9WECsQgqHjAondo',
    'E4YowrHx5wm4RtSjfuvTqtNH3Wf7NEj5tYZGD9Bondo',
    'E6KSaqjvqe2HiUpbEweRxLK4RimQddigm95H9Jaondo',
    'E86mX2yb3HLbJM6gRtZQ6dCYmLh6MSDZadu9SCPondo',
    'E9VQY3VnrpVSekFByzRmfeK1kxgM3UiKCoVVbdUondo',
    'EANjzFjj3nPXHdzN5CE3Z8LLVn69Ce77FE8X4cvondo',
    'EAwP9LGNjTkQ2YeKE6CGKqBYtrJ6APFvRe7KCMmondo',
    'EEy57xbaLcUrN1HXj2vz8VWxeWFK1eZQZo4aWbrondo',
    'EJmUVvDqAdfH5zEohkdS4234bi3c6iunqEMobjmondo',
    'EN5pHc1LccUSojxb7kkyQi7v7iJN5RpDq6qz3DHondo',
    'EXtprP1wzrNo2bByrU9JyzqEg2hQMSCVJakeHHYondo',
    'EYo8D3cLdF1CDeGms5M5VHyU52HJYinkMZ1cqvYondo',
    'Es2ipHL7qXBcLmZ4N7LP9PHBHaWaTMTAkxDwGGjondo',
    'EvsME8gdnEwPLbTnhrGVDwrY35zBuB8hEGCq59Hondo',
    'EvzskrQ3vUUkiMGG1DzfSDyG6H2WCMy3v9G8fzzondo',
    'F3V1fKLKv7H8aNdt9TC6GQ3X4LayEfGHsPi8Umaondo',
    'F3dMJ9H137YUNc9cpN3gBWDSq4MSRbTFtojH65Uondo',
    'FL7QzUq58pvkDxkftJm7RqRWgqYEFZwXuvAMsUnondo',
    'FLqH2jB2DZPJP5nnVFAakRKaNTcDZtq71Pnpp6Aondo',
    'FPvKvWzSzDZqgYmSZUetrkpUXSwo2VtpR4BynVYondo',
    ...ONDO_STOCK_MINTS_20260618,
];

function mapXstockGroupToCoinGeckoId(group: {
    id: string;
    addresses: Array<{ label?: string | null }>;
}): string | null {
    if (!group.id.startsWith('xstock-')) return null;
    const slug = group.id.slice('xstock-'.length).trim();
    if (!slug) return null;

    const labels = group.addresses.map(a => (a.label ?? '').trim().toLowerCase());
    const hasXstock = labels.includes('xstock');

    // Only emit a CoinGecko ID when the group includes an xStock variant.
    // Ondo-only groups have inconsistent CoinGecko IDs (and some aren't listed),
    // so they should be resolved at runtime when needed.
    return hasXstock ? `${slug}-xstock` : null;
}

function mapXstockGroupIdToAssetId(groupId: string): string | null {
    if (!groupId.startsWith('xstock-')) return null;
    // Avoid collisions with real CoinGecko crypto IDs (e.g. `sui`).
    // This keeps the xStock "SUI" token accessible via `assetId=xstock-sui` instead of shadowing the crypto asset.
    if (groupId === 'xstock-sui') return null;
    // Same for TRON: `assetId=tron` should map to TRX (coinId `tron`), not the xStock `tron-xstock`.
    if (groupId === 'xstock-tron') return null;
    const slug = groupId.slice('xstock-'.length).trim();
    return slug.length > 0 ? slug : null;
}

function defaultTrustTier(): TrustTier {
    return 'tier3';
}

function stockVariantTierForEquityVariantLabel(label: string | null | undefined): AssetVariant['stockVariantTier'] {
    const normalized = (label ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (normalized === 'xstock') return 'cash_redeemable';
    if (normalized === 'ondo') return 'cash_redeemable';
    if (normalized === 'backpacksecurities') return 'share_redeemable';
    return 'not_redeemable';
}

function mergeVariants(a: AssetVariant, b: AssetVariant): AssetVariant {
    const mergedTags = new Set<string>([...a.tags, ...b.tags]);

    return {
        variantId: a.variantId,
        mint: a.mint,
        symbol: a.symbol ?? b.symbol,
        name: a.name ?? b.name,
        kind: a.kind,
        issuer: a.issuer ?? b.issuer,
        issuerUrl: a.issuerUrl ?? b.issuerUrl,
        trustTier: a.trustTier,
        tags: Array.from(mergedTags),
        label: a.label ?? b.label,
        stockVariantTier: a.stockVariantTier ?? b.stockVariantTier,
    };
}

// Groups promoted to canonical assets elsewhere — do not auto-generate an equity asset for them.
// `xstock-united-states-oil-fund` is the commodity `oil` in commodities.ts.
const SUPPRESSED_XSTOCK_GROUP_IDS = new Set<string>(['xstock-united-states-oil-fund']);

function buildXstockGroupAssets(): CanonicalAsset[] {
    const assets: CanonicalAsset[] = [];

    for (const group of XSTOCK_VARIANT_GROUPS) {
        if (SUPPRESSED_XSTOCK_GROUP_IDS.has(group.id)) continue;
        const assetId = mapXstockGroupIdToAssetId(group.id) ?? group.id;
        const name = group.label.replace(/\s+variants$/i, '').trim();
        const coingeckoId = mapXstockGroupToCoinGeckoId(group) ?? undefined;
        const symbol = EQUITY_TICKER_BY_SLUG[assetId] ?? undefined;

        const variantsByMint = new Map<string, AssetVariant>();
        for (const item of group.addresses) {
            const suffix = item.label ? item.label.replaceAll(' ', '_') : item.address;
            const next: AssetVariant = {
                variantId: `${assetId}:${suffix}`,
                mint: item.address,
                kind: 'tokenized_equity',
                trustTier: defaultTrustTier(),
                tags: item.label ? [item.label] : [],
                label: item.label,
                stockVariantTier: stockVariantTierForEquityVariantLabel(item.label),
            };

            const prev = variantsByMint.get(next.mint);
            variantsByMint.set(next.mint, prev ? mergeVariants(prev, next) : next);
        }

        const variants = Array.from(variantsByMint.values());

        const aliases = uniqueStrings([
            group.id,
            name,
            ...(symbol ? [symbol] : []),
            ...(coingeckoId ? [coingeckoId] : []),
            ...variants.flatMap(v => [v.mint, v.label ?? '']),
        ]);

        assets.push({
            assetId,
            name,
            ...(symbol ? { symbol } : {}),
            category: 'equity',
            aliases,
            coingeckoId,
            variants,
        });
    }

    return assets;
}

function preStockAssetId(mint: string): string {
    return `pre-${mint.slice(0, 8).toLowerCase()}`;
}

const SPECIAL_EQUITY_MINTS = new Set<string>([
    SPACEX_PRESTOCK_MINT,
    SPACEX_TSPX_MINT,
    SPACEX_ONDO_MINT,
    SPACEX_BACKPACK_MINT,
    SPACEX_XSTOCK_MINT,
    OPENAI_PRESTOCK_MINT,
    OPENAI_TESSERA_MINT,
    DRAM_ONDO_MINT,
    DRAM_BACKPACK_MINT,
    SK_HYNIX_BACKPACK_MINT,
    SK_HYNIX_ONDO_MINT,
    SK_HYNIX_XSTOCK_MINT,
    TAKE_TWO_BACKPACK_MINT,
]);

function buildSpecialEquityAssets(): CanonicalAsset[] {
    return [
        {
            assetId: 'spacex',
            name: 'SpaceX',
            symbol: 'SPCX',
            category: 'equity',
            aliases: uniqueStrings([
                'spacex',
                'SPACEX',
                'SPCX',
                'SPCXon',
                'SPCXx',
                'SpaceX stock',
                SPACEX_ONDO_MINT,
                SPACEX_BACKPACK_MINT,
                SPACEX_XSTOCK_MINT,
                // Legacy `spacex-prestocks` asset — merged into the canonical SpaceX asset.
                // Canonical pricing comes from our ClickHouse stock tables (SPCX market),
                // PreStocks mints remain as variants below.
                'spacex-prestocks',
                'spacex-prestocks-2',
                preStockAssetId(SPACEX_PRESTOCK_MINT),
                SPACEX_PRESTOCK_MINT,
                SPACEX_TSPX_MINT,
                'SPACEX.PRE',
                'TSPX',
                'SpaceX PreStocks',
            ]),
            variants: [
                {
                    variantId: 'spacex:ondo',
                    mint: SPACEX_ONDO_MINT,
                    symbol: 'SPCXon',
                    name: 'SpaceX (Ondo Tokenized)',
                    kind: 'tokenized_equity',
                    issuer: 'Ondo',
                    issuerUrl: 'https://app.ondo.finance/assets/spcxon',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'Ondo'],
                    label: 'Ondo',
                    stockVariantTier: 'cash_redeemable',
                },
                {
                    variantId: 'spacex:backpack',
                    mint: SPACEX_BACKPACK_MINT,
                    symbol: 'SPCX',
                    name: 'SpaceX - Backpack Securities',
                    kind: 'tokenized_equity',
                    issuer: 'Backpack Securities',
                    issuerUrl: 'https://backpack.exchange/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'Backpack Securities'],
                    label: 'Backpack Securities',
                    stockVariantTier: 'share_redeemable',
                },
                {
                    variantId: 'spacex:xstock',
                    mint: SPACEX_XSTOCK_MINT,
                    symbol: 'SPCXx',
                    name: 'SpaceX xStock',
                    kind: 'tokenized_equity',
                    issuer: 'Backed',
                    issuerUrl: 'https://backed.fi/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'xStock'],
                    label: 'xStock',
                    stockVariantTier: 'cash_redeemable',
                },
                {
                    variantId: 'spacex:prestocks',
                    mint: SPACEX_PRESTOCK_MINT,
                    symbol: 'SPACEX',
                    name: 'SpaceX PreStocks',
                    kind: 'tokenized_equity',
                    trustTier: defaultTrustTier(),
                    tags: ['PreStocks'],
                    label: 'PreStocks',
                    stockVariantTier: 'not_redeemable',
                },
                {
                    variantId: 'spacex:tspx',
                    mint: SPACEX_TSPX_MINT,
                    symbol: 'TSPX',
                    name: 'SpaceX',
                    kind: 'tokenized_equity',
                    issuer: 'RWA.xyz',
                    issuerUrl: 'https://app.rwa.xyz/',
                    trustTier: defaultTrustTier(),
                    tags: ['RWA.xyz', 'PreStocks'],
                    label: 'TSPX',
                    stockVariantTier: 'not_redeemable',
                },
            ],
        } satisfies CanonicalAsset,
        {
            assetId: 'openai',
            name: 'OpenAI',
            symbol: 'OPENAI',
            category: 'equity',
            aliases: uniqueStrings([
                'openai',
                'OPENAI',
                'OpenAI stock',
                'OpenAI PreStocks',
                'T-OpenAI',
                'tOpenAI',
                'Tessera OpenAI',
                preStockAssetId(OPENAI_PRESTOCK_MINT),
                OPENAI_PRESTOCK_MINT,
                OPENAI_TESSERA_MINT,
            ]),
            variants: [
                {
                    variantId: 'openai:prestocks',
                    mint: OPENAI_PRESTOCK_MINT,
                    symbol: 'OPENAI',
                    name: 'OpenAI PreStocks',
                    kind: 'tokenized_equity',
                    trustTier: defaultTrustTier(),
                    tags: ['PreStocks'],
                    label: 'PreStocks',
                    stockVariantTier: 'not_redeemable',
                },
                {
                    variantId: 'openai:tessera',
                    mint: OPENAI_TESSERA_MINT,
                    symbol: 'tOpenAI',
                    name: 'T-OpenAI',
                    kind: 'tokenized_equity',
                    issuer: 'Tessera',
                    issuerUrl: 'https://tesseralab.co/',
                    trustTier: defaultTrustTier(),
                    tags: ['Tessera'],
                    label: 'Tessera',
                    stockVariantTier: 'not_redeemable',
                },
            ],
        } satisfies CanonicalAsset,
        {
            assetId: 'roundhill-memory-etf',
            name: 'Roundhill Memory ETF',
            symbol: 'DRAM',
            category: 'etf',
            aliases: uniqueStrings([
                'roundhill-memory-etf',
                'DRAM',
                'Roundhill Memory ETF',
                'xstock-roundhill-memory-etf',
                DRAM_ONDO_MINT,
                DRAM_BACKPACK_MINT,
            ]),
            variants: [
                {
                    variantId: 'roundhill-memory-etf:ondo',
                    mint: DRAM_ONDO_MINT,
                    symbol: 'DRAMon',
                    name: 'Roundhill Memory ETF (Ondo Tokenized)',
                    kind: 'tokenized_equity',
                    issuer: 'Ondo',
                    issuerUrl: 'https://app.ondo.finance/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:etfs', 'Ondo'],
                    label: 'Ondo',
                    stockVariantTier: 'cash_redeemable',
                },
                {
                    variantId: 'roundhill-memory-etf:backpack',
                    mint: DRAM_BACKPACK_MINT,
                    symbol: 'DRAM',
                    name: 'Roundhill Memory ETF - Backpack Securities',
                    kind: 'tokenized_equity',
                    issuer: 'Backpack Securities',
                    issuerUrl: 'https://backpack.exchange/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:etfs', 'Backpack Securities'],
                    label: 'Backpack Securities',
                    stockVariantTier: 'share_redeemable',
                },
            ],
        } satisfies CanonicalAsset,
        {
            assetId: 'sk-hynix',
            name: 'SK Hynix',
            symbol: 'SKHY',
            category: 'equity',
            aliases: uniqueStrings([
                'sk-hynix',
                'SK Hynix',
                'SK hynix',
                'SKHY',
                'SKHYon',
                'SKHYx',
                SK_HYNIX_BACKPACK_MINT,
                SK_HYNIX_ONDO_MINT,
                SK_HYNIX_XSTOCK_MINT,
            ]),
            variants: [
                {
                    variantId: 'sk-hynix:ondo',
                    mint: SK_HYNIX_ONDO_MINT,
                    symbol: 'SKHYon',
                    name: 'SK Hynix (Ondo Tokenized)',
                    kind: 'tokenized_equity',
                    issuer: 'Ondo',
                    issuerUrl: 'https://app.ondo.finance/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'Ondo'],
                    label: 'Ondo',
                    stockVariantTier: 'cash_redeemable',
                },
                {
                    variantId: 'sk-hynix:backpack',
                    mint: SK_HYNIX_BACKPACK_MINT,
                    symbol: 'SKHY',
                    name: 'SK Hynix - Backpack Securities',
                    kind: 'tokenized_equity',
                    issuer: 'Backpack Securities',
                    issuerUrl: 'https://backpack.exchange/stocks/SKHY',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'Backpack Securities'],
                    label: 'Backpack Securities',
                    stockVariantTier: 'share_redeemable',
                },
                {
                    variantId: 'sk-hynix:xstock',
                    mint: SK_HYNIX_XSTOCK_MINT,
                    symbol: 'SKHYx',
                    name: 'SK Hynix xStock',
                    kind: 'tokenized_equity',
                    issuer: 'Backed',
                    issuerUrl: 'https://backed.fi/',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'xStock'],
                    label: 'xStock',
                    stockVariantTier: 'cash_redeemable',
                },
            ],
        } satisfies CanonicalAsset,
        {
            assetId: 'take-two-interactive',
            name: 'Take-Two Interactive',
            symbol: 'TTWO',
            category: 'equity',
            aliases: uniqueStrings([
                'take-two-interactive',
                'Take-Two Interactive',
                'Take-Two Interactive Software',
                'Take Two',
                'TTWO',
                TAKE_TWO_BACKPACK_MINT,
            ]),
            variants: [
                {
                    variantId: 'take-two-interactive:backpack',
                    mint: TAKE_TWO_BACKPACK_MINT,
                    symbol: 'TTWO',
                    name: 'Take-Two Interactive Software - Backpack Securities',
                    kind: 'tokenized_equity',
                    issuer: 'Backpack Securities',
                    issuerUrl: 'https://backpack.exchange/stocks/TTWO',
                    trustTier: defaultTrustTier(),
                    tags: ['curated:stocks', 'Backpack Securities'],
                    label: 'Backpack Securities',
                    stockVariantTier: 'share_redeemable',
                },
            ],
        } satisfies CanonicalAsset,
    ];
}

function buildPreStockAssets(existingMints: ReadonlySet<string>): CanonicalAsset[] {
    return PRE_STOCK_MINTS.filter(mint => !existingMints.has(mint) && !SPECIAL_EQUITY_MINTS.has(mint)).map(mint => {
        const assetId = preStockAssetId(mint);
        const metadata = PRE_STOCK_METADATA[mint];

        return {
            assetId,
            ...(metadata ? { name: metadata.name, symbol: metadata.symbol } : {}),
            category: 'equity',
            aliases: uniqueStrings([assetId, mint, ...(metadata ? [metadata.symbol, metadata.name] : [])]),
            variants: [
                {
                    variantId: `${assetId}:mint`,
                    mint,
                    ...(metadata ? { symbol: metadata.symbol, name: metadata.name } : {}),
                    kind: 'tokenized_equity',
                    trustTier: defaultTrustTier(),
                    tags: metadata ? ['curated:stocks', 'PreStocks'] : ['curated:stocks'],
                    ...(metadata ? { label: 'PreStocks' } : {}),
                    stockVariantTier: 'not_redeemable',
                },
            ],
        } satisfies CanonicalAsset;
    });
}

function unlistedStockAssetId(mint: string): string {
    return `stock-${mint.slice(0, 8).toLowerCase()}`;
}

function buildUnlistedStockAssets(existingMints: ReadonlySet<string>): CanonicalAsset[] {
    return UNLISTED_STOCK_MINTS.filter(mint => !existingMints.has(mint) && !SPECIAL_EQUITY_MINTS.has(mint)).map(
        mint => {
            const assetId = unlistedStockAssetId(mint);

            return {
                assetId,
                category: 'equity',
                aliases: uniqueStrings([assetId, mint]),
                variants: [
                    {
                        variantId: `${assetId}:ondo`,
                        mint,
                        kind: 'tokenized_equity',
                        trustTier: defaultTrustTier(),
                        tags: ['manual', 'Ondo'],
                        label: 'Ondo',
                        stockVariantTier: 'cash_redeemable',
                    },
                ],
            } satisfies CanonicalAsset;
        },
    );
}

export const EQUITY_ASSETS: CanonicalAsset[] = (() => {
    const xstocks = buildXstockGroupAssets();
    const existingMints = new Set<string>();
    for (const asset of xstocks) for (const variant of asset.variants) existingMints.add(variant.mint);

    const specialEquities = buildSpecialEquityAssets();
    for (const asset of specialEquities) for (const variant of asset.variants) existingMints.add(variant.mint);

    const preStocks = buildPreStockAssets(existingMints);
    for (const asset of preStocks) for (const variant of asset.variants) existingMints.add(variant.mint);

    const unlistedStocks = buildUnlistedStockAssets(existingMints);

    return [...xstocks, ...specialEquities, ...preStocks, ...unlistedStocks];
})();
