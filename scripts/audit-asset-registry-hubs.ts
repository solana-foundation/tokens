/* eslint-disable no-console */

import {
    CURRENCY_MINTS,
    ETF_MINTS,
    LST_MINTS,
    MAJORS_MINTS,
    METALS_MINTS,
    RWA_MINTS,
    STOCKS_MINTS,
} from '../packages/asset-registry/src/data/list-mints.ts';

const REGISTRY_LIST_MINTS = [
    { id: 'majors', addresses: MAJORS_MINTS },
    { id: 'lsts', addresses: LST_MINTS },
    { id: 'currencies', addresses: CURRENCY_MINTS },
    { id: 'rwas', addresses: RWA_MINTS },
    { id: 'etfs', addresses: ETF_MINTS },
    { id: 'metals', addresses: METALS_MINTS },
    { id: 'stocks', addresses: STOCKS_MINTS },
];
import { MINT_HOME_OVERRIDES } from '../packages/asset-registry/src/data/mint-home-overrides.ts';
import { getHubByMint } from '../packages/asset-registry/src/hubs.ts';
import { getVariantHubById } from '../packages/asset-registry/src/variant-hubs.ts';
import { listAssets, listVariantMatchesByMint } from '../packages/asset-registry/src/registry.ts';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function main(): void {
    const errors: string[] = [];

    // 1) All curated mints resolve.
    for (const list of REGISTRY_LIST_MINTS) {
        if (!list || typeof list !== 'object') continue;
        const listId = String((list as { id?: unknown }).id ?? '');
        const addresses = Array.isArray((list as { addresses?: unknown }).addresses)
            ? ((list as { addresses: unknown[] }).addresses as unknown[])
            : [];

        for (const mintRaw of addresses) {
            const mint = String(mintRaw ?? '').trim();
            if (!mint) continue;
            const match = getHubByMint(mint);
            if (!match) errors.push(`[missing-hub] list=${listId} mint=${mint}`);
        }
    }

    // 2) Duplicate mints are fully covered by overrides.
    const candidateHubIdsByMint = new Map<string, Set<string>>();
    for (const asset of listAssets()) {
        for (const variant of asset.variants) {
            const set = candidateHubIdsByMint.get(variant.mint) ?? new Set<string>();
            set.add(asset.assetId);
            candidateHubIdsByMint.set(variant.mint, set);
        }
    }

    for (const [mint, candidateIdsSet] of candidateHubIdsByMint.entries()) {
        if (candidateIdsSet.size <= 1) continue;
        const candidates = Array.from(candidateIdsSet.values()).sort();

        const override = (MINT_HOME_OVERRIDES[mint] ?? '').trim();
        if (!override) {
            errors.push(`[missing-mint-home-override] mint=${mint} candidates=${candidates.join(',')}`);
            continue;
        }

        if (!candidateIdsSet.has(override)) {
            errors.push(
                `[invalid-mint-home-override] mint=${mint} override=${override} candidates=${candidates.join(',')}`,
            );
            continue;
        }

        // Sanity: registry debug API should reflect the same candidates.
        const matches = listVariantMatchesByMint(mint);
        const idsFromRegistry = Array.from(new Set(matches.map(m => m.asset.assetId))).sort();
        if (idsFromRegistry.join(',') !== candidates.join(',')) {
            errors.push(
                `[inconsistent-variant-matches] mint=${mint} candidates=${candidates.join(',')} registry=${idsFromRegistry.join(',')}`,
            );
        }
    }

    // 3) Variant hub correctness for multi-variant assets.
    for (const asset of listAssets()) {
        if (asset.variants.length <= 1) continue;

        const hub = getVariantHubById(asset.assetId);
        if (!hub) {
            errors.push(`[missing-variant-hub] assetId=${asset.assetId}`);
            continue;
        }

        if (hub.id !== asset.assetId) {
            errors.push(`[variant-hub-id-mismatch] assetId=${asset.assetId} hubId=${hub.id}`);
        }

        const expectedMints = asset.variants.map(v => v.mint);
        const actualMints = hub.addresses.map(a => a.address);

        if (expectedMints.length !== actualMints.length) {
            errors.push(
                `[variant-hub-length-mismatch] assetId=${asset.assetId} expected=${expectedMints.length} actual=${actualMints.length}`,
            );
            continue;
        }

        for (let i = 0; i < expectedMints.length; i++) {
            if (expectedMints[i] !== actualMints[i]) {
                errors.push(
                    `[variant-hub-order-mismatch] assetId=${asset.assetId} index=${i} expected=${expectedMints[i]} actual=${actualMints[i]}`,
                );
                break;
            }
        }
    }

    if (errors.length > 0) {
        console.error(['Asset registry hubs audit failed', `errors=${errors.length}`].join(' | '));
        for (const e of errors.slice(0, 200)) console.error(`- ${e}`);
        if (errors.length > 200) console.error(`...and ${errors.length - 200} more`);
        process.exit(1);
    }

    console.log('Asset registry hubs audit OK');
}

try {
    main();
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(false, message);
}
