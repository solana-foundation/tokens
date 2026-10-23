/* eslint-disable no-console */
/**
 * Generates packages/asset-registry/src/data/issuance-overrides.ts from the
 * live catalog: every active variant with the CoinGecko coin it links to
 * (v2_asset_variants.coingecko_id, written by sync-v2-evm-variants / the
 * resolver / admin) plus the coin rows, classified by
 * apps/cloudrun-assets/src/handlers/issuanceOverridesGenerator.ts.
 *
 * Read-only against Postgres (DATABASE_URL, e.g. apps/cloudrun-assets/.env.local
 * or a replica). Prints the module to stdout; `--write` replaces the data file
 * so the PR diff is the review surface. Run after sync-v2-evm-variants has
 * populated coin ids (migration 0035).
 *
 *   DATABASE_URL=... bun scripts/generate-issuance-overrides.ts --write
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

import { isChainKind } from '@tokens/asset-registry/chains';

import {
    classifyIssuanceOverrides,
    renderIssuanceOverridesModule,
    type OverrideCoinInput,
    type OverrideVariantInput,
} from '../apps/cloudrun-assets/src/handlers/issuanceOverridesGenerator';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
    console.error('DATABASE_URL is not set (apps/cloudrun-assets/.env.local or a replica URL)');
    process.exit(1);
}
const write = process.argv.includes('--write');
const sql = postgres(databaseUrl, { max: 1 });

try {
    const variantRows = await sql<
        { chain: string; address: string; asset_id: string; category: string; kind: string; label: string | null; source: string | null; origin: string; coingecko_id: string | null }[]
    >`
        SELECT v.chain, v.address, v.asset_id, a.category, v.kind, v.label, v.source, v.origin, v.coingecko_id
        FROM v2_asset_variants v
        JOIN assets a ON a.asset_id = v.asset_id AND a.is_active = true
        WHERE v.is_active = true
          AND NOT EXISTS (SELECT 1 FROM asset_deletion_tombstones dt WHERE dt.asset_id = v.asset_id)
        ORDER BY v.asset_id, v.chain, v.address
    `;
    const variants: OverrideVariantInput[] = variantRows.flatMap(row =>
        isChainKind(row.chain)
            ? [
                  {
                      chain: row.chain,
                      address: row.address,
                      assetId: row.asset_id,
                      category: row.category,
                      kind: row.kind,
                      label: row.label,
                      source: row.origin === 'solana_v1' ? row.source : row.origin,
                      coinId: row.coingecko_id,
                  },
              ]
            : [],
    );
    const coinIds = [...new Set(variants.flatMap(v => (v.coinId ? [v.coinId] : [])))];
    const coinRows =
        coinIds.length === 0
            ? []
            : await sql<{ coin_id: string; name: string; symbol: string; platforms: unknown }[]>`
                  SELECT coin_id, name, symbol, platforms FROM coingecko_coins WHERE coin_id IN ${sql(coinIds)}
              `;
    const coins: OverrideCoinInput[] = coinRows.map(row => {
        const raw = typeof row.platforms === 'string' ? JSON.parse(row.platforms) : row.platforms;
        const platforms: Record<string, string> = {};
        if (raw && typeof raw === 'object') {
            for (const [platform, address] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof address === 'string') platforms[platform] = address;
            }
        }
        return { coinId: row.coin_id, name: row.name, symbol: row.symbol, platforms };
    });

    const entries = classifyIssuanceOverrides(variants, coins);
    const module = renderIssuanceOverridesModule(entries, new Date().toISOString().slice(0, 10));
    const byIssuance = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.issuance]: (acc[e.issuance] ?? 0) + 1 }), {});
    console.error(`variants=${variants.length} linked=${coinIds.length} coins=${coins.length} entries=${entries.length} ${JSON.stringify(byIssuance)}`);
    if (write) {
        const target = resolve(import.meta.dir, '../packages/asset-registry/src/data/issuance-overrides.ts');
        writeFileSync(target, module);
        console.error(`wrote ${target}`);
    } else {
        process.stdout.write(module);
    }
} finally {
    await sql.end();
}
