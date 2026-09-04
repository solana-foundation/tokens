/**
 * Generate apps/cloudrun-assets/src/data/curated-collections-seed.json — the
 * frozen, asset-level bootstrap fixture for `asset_collections(_members)`.
 *
 * Run this ONCE right before the DB-authority cutover merges (regenerate at
 * merge week if the compiled arrays changed since implementation):
 *
 *   bun scripts/generate-curated-collections-fixture.ts
 *
 * Sources (both scheduled for deletion after cutover — the fixture is their
 * permanent replacement):
 * - compiled list arrays via the deprecated curated-token-lists shim
 * - the git-history added-at map (curated-token-added-at.ts). NEVER
 *   regenerate that map in this repo: the OSS squash destroyed the history.
 *
 * Semantics (mirrors the retired seed merge, buildCollectionMembersFromMints):
 * - membership is asset-level: mints resolve through the compiled registry;
 *   unresolvable mints are skipped (reported)
 * - rank = the asset's first mint's array index
 * - addedAtMs = min git added-at across the asset's mints (fallback: now)
 */
import fs from 'node:fs';
import path from 'node:path';

import { getVariantByMint } from '../packages/asset-registry/src/registry.ts';
import {
    CURATED_LIST_ORDER,
    CURATED_TOKEN_LISTS,
} from '../packages/asset-registry/src/data/curated-token-lists.ts';
import { CURATED_TOKEN_ADDED_AT } from '../packages/asset-registry/src/data/curated-token-added-at.ts';

interface FixtureMember {
    assetId: string;
    rank: number;
    addedAtMs: number;
}

interface FixtureCollection {
    slug: string;
    title: string;
    description: string;
    members: FixtureMember[];
}

const generatedAtMs = Date.now();
const collections: FixtureCollection[] = [];
const unresolved: Array<{ slug: string; mint: string }> = [];
const missingAddedAt: Array<{ slug: string; mint: string }> = [];

for (const slug of CURATED_LIST_ORDER) {
    const list = CURATED_TOKEN_LISTS[slug];
    const rankByAssetId = new Map<string, number>();
    const addedAtByAssetId = new Map<string, number>();
    for (let i = 0; i < list.addresses.length; i += 1) {
        const mint = list.addresses[i]!;
        const assetId = getVariantByMint(mint)?.asset.assetId ?? null;
        if (!assetId) {
            unresolved.push({ slug, mint });
            continue;
        }
        if (!rankByAssetId.has(assetId)) rankByAssetId.set(assetId, i);
        const addedAtRaw = CURATED_TOKEN_ADDED_AT[mint];
        if (addedAtRaw === undefined) missingAddedAt.push({ slug, mint });
        const addedAt = addedAtRaw ?? generatedAtMs;
        const existing = addedAtByAssetId.get(assetId);
        if (existing === undefined || addedAt < existing) addedAtByAssetId.set(assetId, addedAt);
    }
    collections.push({
        slug,
        title: list.name,
        description: list.description,
        members: Array.from(rankByAssetId.entries())
            .map(([assetId, rank]) => ({ assetId, rank, addedAtMs: addedAtByAssetId.get(assetId) ?? generatedAtMs }))
            .sort((a, b) => a.rank - b.rank),
    });
}

const outPath = path.join(import.meta.dirname, '..', 'apps/cloudrun-assets/src/data/curated-collections-seed.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(collections, null, 4)}\n`);

console.log(
    `Wrote ${path.relative(process.cwd(), outPath)} | collections=${collections.length} | members=${collections.reduce((n, c) => n + c.members.length, 0)}`,
);
if (unresolved.length > 0) {
    console.warn(`Skipped ${unresolved.length} unresolvable mints:`);
    for (const item of unresolved) console.warn(`  ${item.slug}: ${item.mint}`);
}
if (missingAddedAt.length > 0) {
    console.warn(`${missingAddedAt.length} mints missing git added-at (stamped generation time):`);
    for (const item of missingAddedAt) console.warn(`  ${item.slug}: ${item.mint}`);
}
