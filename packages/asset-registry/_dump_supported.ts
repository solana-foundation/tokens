import { CANONICAL_ASSETS } from './src/data/index';
import { readFileSync } from 'node:fs';

const seed = JSON.parse(
    readFileSync(new URL('../../apps/cloudrun-assets/src/data/curated-collections-seed.json', import.meta.url), 'utf8'),
) as Array<{ slug: string; title: string; members: Array<{ assetId: string; rank: number }> }>;

const byId = new Map(CANONICAL_ASSETS.map(a => [a.assetId, a]));

for (const list of seed) {
    console.log(`\n## ${list.title} (${list.slug}) — ${list.members.length}`);
    const sorted = [...list.members].sort((a, b) => a.rank - b.rank);
    for (const m of sorted) {
        const asset = byId.get(m.assetId);
        if (!asset) {
            console.log(`${m.assetId}\tMISSING_FROM_REGISTRY`);
            continue;
        }
        const solanaVariant = asset.variants.find(v => v.mint) ?? asset.variants[0];
        const name = asset.name ?? solanaVariant?.name ?? '(no static name — resolved live)';
        console.log(`${name}\t${solanaVariant?.mint ?? 'NO_MINT'}`);
    }
}
