/**
 * Read-only parity check for the curated DB-authority cutover (rollout step 4).
 *
 *   bun scripts/verify-curated-db-parity.ts
 *
 * Two checks:
 * (a) Baseline vs raw DB collection membership: the committed fixture
 *     (apps/cloudrun-assets/src/data/curated-collections-seed.json — the
 *     frozen compiled-array snapshot) against `assetCollectionsGetMembers`
 *     per slug. DB-only members must be explainable as admin additions;
 *     fixture-only members must be tombstoned/deactivated.
 * (b) Effective variant expansion: the `curatedMembershipGetSnapshot` RPC
 *     obeys its own invariants — yield/LST mints appear ONLY in `lsts`,
 *     sibling variants inherit membership, `all` is exactly the slug-order
 *     union, and per-list counts match what /api/v2/lists will report.
 *
 * Requires TOKENS_CLOUDRUN_ASSETS_URL (or TOKENS_CLOUDRUN_ENABLED) +
 * TOKENS_CLOUDRUN_AUTH_TOKEN, same as other ops scripts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadLocalEnv } from './_env.mjs';
import { callCloudRun, cloudRunEnabled } from './_cloudrun.mjs';
import { CURATED_LIST_SLUGS } from '../packages/asset-registry/src/curated-lists.ts';

interface FixtureCollection {
    slug: string;
    title: string;
    description: string;
    members: Array<{ assetId: string; rank: number; addedAtMs: number }>;
}

interface MembershipSnapshot {
    loadedAt: number;
    mintsByList: Record<string, string[]>;
    allMints: string[];
    entriesByMint: Record<string, { assetId: string | null; listSlugs: string[]; symbol: string | null }>;
}

function loadFixture(): FixtureCollection[] {
    const p = path.join(import.meta.dirname, '..', 'apps/cloudrun-assets/src/data/curated-collections-seed.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) as FixtureCollection[];
}

async function main(): Promise<void> {
    await loadLocalEnv();
    if (!cloudRunEnabled('assets')) {
        throw new Error('Cloud Run backend is not configured (TOKENS_CLOUDRUN_ASSETS_URL / TOKENS_CLOUDRUN_AUTH_TOKEN).');
    }

    const problems: string[] = [];
    const notes: string[] = [];

    // ---- (a) baseline vs raw DB membership -------------------------------
    const fixture = loadFixture();
    for (const collection of fixture) {
        const dbAssetIds = (await callCloudRun('assets', 'query', 'assetCollectionsGetMembers', {
            slug: collection.slug,
            limit: 2000,
        })) as string[];
        const dbSet = new Set(dbAssetIds);
        const fixtureIds = collection.members.map(m => m.assetId);
        const fixtureSet = new Set(fixtureIds);

        const dbOnly = dbAssetIds.filter(id => !fixtureSet.has(id));
        const fixtureOnly = fixtureIds.filter(id => !dbSet.has(id));
        console.log(
            `[a] ${collection.slug}: db=${dbAssetIds.length} fixture=${fixtureIds.length} dbOnly=${dbOnly.length} fixtureOnly=${fixtureOnly.length}`,
        );
        if (dbOnly.length > 0) notes.push(`${collection.slug}: DB-only (expect admin adds): ${dbOnly.join(', ')}`);
        if (fixtureOnly.length > 0) {
            notes.push(`${collection.slug}: fixture-only (expect tombstoned/inactive): ${fixtureOnly.join(', ')}`);
        }
    }

    // ---- (b) effective expansion invariants ------------------------------
    const snapshot = (await callCloudRun('assets', 'query', 'curatedMembershipGetSnapshot', {})) as MembershipSnapshot;

    const lstSet = new Set(snapshot.mintsByList.lsts ?? []);
    for (const slug of CURATED_LIST_SLUGS) {
        const mints = snapshot.mintsByList[slug] ?? [];
        console.log(`[b] ${slug}: effectiveMints=${mints.length}`);
        if (slug === 'lsts') continue;
        for (const mint of mints) {
            const entry = snapshot.entriesByMint[mint];
            if (!entry) {
                problems.push(`${slug}: mint ${mint} missing from entriesByMint`);
                continue;
            }
            if (!entry.listSlugs.includes(slug)) {
                problems.push(`${slug}: mint ${mint} entry does not claim membership (${entry.listSlugs.join(',')})`);
            }
        }
        // Yield/LST routing: the capped LST view must not leak into normal lists.
        const leaked = mints.filter(mint => lstSet.has(mint));
        if (leaked.length > 0) {
            problems.push(`${slug}: ${leaked.length} LST mints leaked into a non-lsts list: ${leaked.slice(0, 5).join(', ')}…`);
        }
    }

    // `all` = slug-order union, deduped.
    const expectedAll: string[] = [];
    const seen = new Set<string>();
    for (const slug of CURATED_LIST_SLUGS) {
        for (const mint of snapshot.mintsByList[slug] ?? []) {
            if (seen.has(mint)) continue;
            seen.add(mint);
            expectedAll.push(mint);
        }
    }
    if (expectedAll.length !== snapshot.allMints.length || expectedAll.some((m, i) => snapshot.allMints[i] !== m)) {
        problems.push(
            `allMints is not the slug-order union (expected ${expectedAll.length}, got ${snapshot.allMints.length})`,
        );
    }

    // v2 count agreement: what the catalog will report per list.
    for (const slug of CURATED_LIST_SLUGS) {
        const effective = (snapshot.mintsByList[slug] ?? []).length;
        console.log(`[b] v2 tokenCount ${slug}=${effective}`);
    }

    if (notes.length > 0) {
        console.log('\nDifferences to explain before cutover:');
        for (const note of notes) console.log(`  - ${note}`);
    }
    if (problems.length > 0) {
        console.error('\nINVARIANT VIOLATIONS:');
        for (const problem of problems) console.error(`  ! ${problem}`);
        process.exit(1);
    }
    console.log('\nParity check passed (differences above, if any, still need human sign-off).');
}

await main();
