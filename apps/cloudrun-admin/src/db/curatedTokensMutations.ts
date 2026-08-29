/**
 * Postgres implementation of `AdminMutationsRepo` (see
 * handlers/curatedTokensMutations.ts). Every repo method runs in a single
 * postgres-js `sql.begin` transaction, mirroring Convex mutation atomicity.
 *
 * Fetch-merge-update mirrors Convex `db.replace`: the current row is read
 * `FOR UPDATE`, merged with the tri-state changes in TS, and written back.
 */

import type { Sql, TransactionSql } from 'postgres';

import { ALIAS_PRIORITIES, type AdminMutationsRepo } from '../handlers/curatedTokensMutations';
import { ASSET_ALIAS_KINDS, CURATED_CATEGORY_SLUGS, type CuratedCategorySlug } from '../handlers/shared';
import { CURATED_LIST_FALLBACK_NAMES } from '@tokens/asset-registry/curated-lists';

import { randomId } from '../db';

type Tx = TransactionSql;

/** Exported for tests (recording fake `tx`). */
export async function replaceAliasesForKind(
    tx: Tx,
    args: { assetId: string; kind: 'name' | 'symbol' | 'coingeckoId'; alias: string | null; nowMs: number },
): Promise<void> {
    await tx`DELETE FROM asset_aliases WHERE asset_id = ${args.assetId} AND kind = ${args.kind}`;
    if (!args.alias) return;
    const now = new Date(args.nowMs);
    await tx`
        INSERT INTO asset_aliases (id, normalized, alias, asset_id, kind, priority, created_at, updated_at)
        VALUES (
            ${randomId('aal')}, ${args.alias.toLowerCase()}, ${args.alias}, ${args.assetId},
            ${args.kind}, ${ALIAS_PRIORITIES[args.kind]}, ${now}, ${now}
        )
        ON CONFLICT (asset_id, normalized, kind) DO UPDATE SET
            alias = EXCLUDED.alias,
            priority = EXCLUDED.priority,
            updated_at = EXCLUDED.updated_at
    `;
}

/** Exported for tests (recording fake `tx`). */
export async function replaceCustomAliases(
    tx: Tx,
    args: { assetId: string; aliases: readonly string[]; nowMs: number },
): Promise<void> {
    await tx`DELETE FROM asset_aliases WHERE asset_id = ${args.assetId} AND kind = 'custom'`;
    const now = new Date(args.nowMs);
    // Unique index on (asset_id, normalized, kind): keep the first alias per
    // lowercase form (Convex could store case-variants; Postgres cannot).
    const seen = new Set<string>();
    for (const alias of args.aliases) {
        const normalized = alias.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        await tx`
            INSERT INTO asset_aliases (id, normalized, alias, asset_id, kind, priority, created_at, updated_at)
            VALUES (
                ${randomId('aal')}, ${normalized}, ${alias}, ${args.assetId},
                'custom', ${ALIAS_PRIORITIES.custom}, ${now}, ${now}
            )
            ON CONFLICT (asset_id, normalized, kind) DO NOTHING
        `;
    }
}

/**
 * Port of Convex `syncCanonicalCollections`: remove memberships for curated
 * slugs not requested, insert missing ones with rank = COALESCE(MAX(rank),-1)+1
 * computed in-transaction.
 */
export async function syncCollections(
    tx: Tx,
    args: { assetId: string; collections: readonly CuratedCategorySlug[]; nowMs: number },
): Promise<void> {
    const next = new Set(args.collections);
    for (const slug of CURATED_CATEGORY_SLUGS) {
        if (!next.has(slug)) {
            await tx`
                DELETE FROM asset_collection_members
                WHERE asset_id = ${args.assetId} AND collection_slug = ${slug}
            `;
            continue;
        }
        await tx`
            INSERT INTO asset_collection_members (id, collection_slug, asset_id, rank, added_at, source)
            SELECT ${randomId('acm')}, ${slug}, ${args.assetId},
                   (SELECT COALESCE(MAX(rank), -1) + 1 FROM asset_collection_members WHERE collection_slug = ${slug}),
                   ${args.nowMs}, 'admin'
            WHERE NOT EXISTS (
                SELECT 1 FROM asset_collection_members
                WHERE asset_id = ${args.assetId} AND collection_slug = ${slug}
            )
        `;
    }
}

interface CurrentAssetRow {
    category: string;
    name: string | null;
    symbol: string | null;
    coingecko_id: string | null;
    description: string | null;
    image_url: string | null;
    is_active: boolean;
}

interface CurrentVariantRow {
    id: string;
    asset_id: string;
    variant_id: string;
    kind: string;
    trust_tier: string;
    tags: unknown;
    label: string | null;
    issuer: string | null;
    issuer_url: string | null;
    stock_variant_tier: string | null;
    is_active: boolean;
}

export function makePostgresAdminMutationsRepo(sql: Sql): AdminMutationsRepo {
    return {
        async createCanonicalAsset(args) {
            return await sql.begin(async tx => {
                const existing = await tx`SELECT 1 FROM assets WHERE asset_id = ${args.assetId} LIMIT 1`;
                if (existing.length > 0) return 'exists' as const;
                const now = new Date(args.nowMs);
                await tx`
                    INSERT INTO assets (
                        id, asset_id, category, name, symbol, coingecko_id, description,
                        image_url, is_active, created_at, updated_at, admin_edited_at
                    )
                    VALUES (
                        ${randomId('ast')}, ${args.assetId}, ${args.category},
                        ${args.name}, ${args.symbol}, ${args.coingeckoId}, ${args.description},
                        ${args.imageUrl}, true, ${now}, ${now}, ${args.nowMs}
                    )
                `;
                await replaceAliasesForKind(tx, {
                    assetId: args.assetId,
                    kind: 'name',
                    alias: args.name,
                    nowMs: args.nowMs,
                });
                await replaceAliasesForKind(tx, {
                    assetId: args.assetId,
                    kind: 'symbol',
                    alias: args.symbol,
                    nowMs: args.nowMs,
                });
                await replaceAliasesForKind(tx, {
                    assetId: args.assetId,
                    kind: 'coingeckoId',
                    alias: args.coingeckoId,
                    nowMs: args.nowMs,
                });
                await replaceCustomAliases(tx, {
                    assetId: args.assetId,
                    aliases: args.aliases,
                    nowMs: args.nowMs,
                });
                await syncCollections(tx, {
                    assetId: args.assetId,
                    collections: args.collections,
                    nowMs: args.nowMs,
                });
                return 'created' as const;
            });
        },

        async updateCanonicalAsset(args) {
            return await sql.begin(async tx => {
                const rows = await tx<CurrentAssetRow[]>`
                    SELECT category, name, symbol, coingecko_id, description, image_url, is_active
                    FROM assets WHERE asset_id = ${args.assetId}
                    LIMIT 1
                    FOR UPDATE
                `;
                const current = rows[0];
                if (!current) return 'not_found' as const;

                const nextCategory = args.category !== undefined ? args.category : current.category;
                const nextName = args.name !== undefined ? args.name : current.name;
                const nextSymbol = args.symbol !== undefined ? args.symbol : current.symbol;
                const nextCoingeckoId = args.coingeckoId !== undefined ? args.coingeckoId : current.coingecko_id;
                const nextDescription = args.description !== undefined ? args.description : current.description;
                const nextImageUrl = args.clearImage
                    ? null
                    : args.imageUrl !== undefined
                      ? args.imageUrl
                      : current.image_url;
                const nextIsActive = args.isActive !== undefined ? args.isActive : current.is_active;

                await tx`
                    UPDATE assets SET
                        category = ${nextCategory},
                        name = ${nextName},
                        symbol = ${nextSymbol},
                        coingecko_id = ${nextCoingeckoId},
                        description = ${nextDescription},
                        image_url = ${nextImageUrl},
                        is_active = ${nextIsActive},
                        updated_at = ${new Date(args.nowMs)},
                        admin_edited_at = ${args.nowMs}
                    WHERE asset_id = ${args.assetId}
                `;

                if (args.name !== undefined) {
                    await replaceAliasesForKind(tx, {
                        assetId: args.assetId,
                        kind: 'name',
                        alias: args.name,
                        nowMs: args.nowMs,
                    });
                }
                if (args.symbol !== undefined) {
                    await replaceAliasesForKind(tx, {
                        assetId: args.assetId,
                        kind: 'symbol',
                        alias: args.symbol,
                        nowMs: args.nowMs,
                    });
                }
                if (args.coingeckoId !== undefined) {
                    await replaceAliasesForKind(tx, {
                        assetId: args.assetId,
                        kind: 'coingeckoId',
                        alias: args.coingeckoId,
                        nowMs: args.nowMs,
                    });
                }
                if (args.aliases !== undefined) {
                    await replaceCustomAliases(tx, {
                        assetId: args.assetId,
                        aliases: args.aliases,
                        nowMs: args.nowMs,
                    });
                }
                if (args.collections !== undefined) {
                    await syncCollections(tx, {
                        assetId: args.assetId,
                        collections: args.collections,
                        nowMs: args.nowMs,
                    });
                }
                return 'updated' as const;
            });
        },

        async deleteCanonicalAsset(args) {
            return await sql.begin(async tx => {
                const existing = await tx`SELECT 1 FROM assets WHERE asset_id = ${args.assetId} LIMIT 1 FOR UPDATE`;
                if (existing.length === 0) return 'not_found' as const;
                const variants = await tx`
                    SELECT 1 FROM asset_variants WHERE asset_id = ${args.assetId} LIMIT 1
                `;
                if (variants.length > 0) return 'has_variants' as const;

                await tx`
                    DELETE FROM asset_collection_members
                    WHERE asset_id = ${args.assetId}
                      AND collection_slug = ANY(${sql.array(CURATED_CATEGORY_SLUGS as unknown as string[])}::text[])
                `;
                await tx`
                    DELETE FROM asset_aliases
                    WHERE asset_id = ${args.assetId}
                      AND kind = ANY(${sql.array(ASSET_ALIAS_KINDS as unknown as string[])}::text[])
                `;
                await tx`DELETE FROM asset_markets_latest WHERE asset_id = ${args.assetId}`;
                await tx`DELETE FROM assets WHERE asset_id = ${args.assetId}`;
                return 'deleted' as const;
            });
        },

        async createVariant(args) {
            return await sql.begin(async tx => {
                const asset = await tx`SELECT 1 FROM assets WHERE asset_id = ${args.assetId} LIMIT 1`;
                if (asset.length === 0) return { status: 'asset_not_found' as const };

                const byMint = await tx<Array<{ asset_id: string }>>`
                    SELECT asset_id FROM asset_variants WHERE mint = ${args.mint} ORDER BY id ASC LIMIT 1
                `;
                if (byMint[0]) return { status: 'mint_exists' as const, ownerAssetId: byMint[0].asset_id };

                const byVariantId = await tx`
                    SELECT 1 FROM asset_variants
                    WHERE asset_id = ${args.assetId} AND variant_id = ${args.variantId}
                    LIMIT 1
                `;
                if (byVariantId.length > 0) return { status: 'variant_id_exists' as const };

                const now = new Date(args.nowMs);
                await tx`
                    INSERT INTO asset_variants (
                        id, asset_id, chain, mint, variant_id, kind, trust_tier,
                        stock_variant_tier, tags, issuer, issuer_url, label,
                        is_active, created_at, updated_at
                    )
                    VALUES (
                        ${randomId('avr')}, ${args.assetId}, 'solana', ${args.mint}, ${args.variantId},
                        ${args.kind}, ${args.trustTier}, ${args.stockVariantTier},
                        ${JSON.stringify(args.tags)}::jsonb,
                        ${args.issuer}, ${args.issuerUrl}, ${args.label},
                        ${args.isActive}, ${now}, ${now}
                    )
                `;

                const marketProvided =
                    args.marketSymbol !== undefined ||
                    args.marketName !== undefined ||
                    args.marketLogoURI !== undefined;
                const market = await tx<Array<{ symbol: string | null; name: string | null; logo_uri: string | null }>>`
                    SELECT symbol, name, logo_uri FROM variant_markets_latest
                    WHERE mint = ${args.mint} LIMIT 1 FOR UPDATE
                `;
                if (market[0]) {
                    const current = market[0];
                    await tx`
                        UPDATE variant_markets_latest SET
                            symbol = ${args.marketSymbol !== undefined ? args.marketSymbol : current.symbol},
                            name = ${args.marketName !== undefined ? args.marketName : current.name},
                            logo_uri = ${args.marketLogoURI !== undefined ? args.marketLogoURI : current.logo_uri}
                        WHERE mint = ${args.mint}
                    `;
                } else if (marketProvided) {
                    await tx`
                        INSERT INTO variant_markets_latest (id, mint, source, symbol, name, logo_uri, last_fetched_at)
                        VALUES (
                            ${randomId('vml')}, ${args.mint}, 'birdeye',
                            ${args.marketSymbol ?? null}, ${args.marketName ?? null}, ${args.marketLogoURI ?? null},
                            ${args.nowMs}
                        )
                    `;
                }
                return { status: 'created' as const };
            });
        },

        async updateVariant(args) {
            return await sql.begin(async tx => {
                const rows = await tx<CurrentVariantRow[]>`
                    SELECT id, asset_id, variant_id, kind, trust_tier, tags, label,
                           issuer, issuer_url, stock_variant_tier, is_active
                    FROM asset_variants
                    WHERE mint = ${args.mint}
                    ORDER BY id ASC
                    LIMIT 1
                    FOR UPDATE
                `;
                const current = rows[0];
                if (!current) return 'not_found' as const;

                let nextVariantId = current.variant_id;
                if (args.variantId !== undefined) {
                    const collision = await tx<Array<{ id: string }>>`
                        SELECT id FROM asset_variants
                        WHERE asset_id = ${current.asset_id} AND variant_id = ${args.variantId}
                        LIMIT 1
                    `;
                    if (collision[0] && collision[0].id !== current.id) return 'variant_id_collision' as const;
                    nextVariantId = args.variantId;
                }

                const currentTags = Array.isArray(current.tags) ? (current.tags as string[]) : [];
                const nextTags = args.tags !== undefined ? args.tags : currentTags;
                await tx`
                    UPDATE asset_variants SET
                        variant_id = ${nextVariantId},
                        kind = ${args.kind !== undefined ? args.kind : current.kind},
                        trust_tier = ${args.trustTier !== undefined ? args.trustTier : current.trust_tier},
                        tags = ${JSON.stringify(nextTags)}::jsonb,
                        label = ${args.label !== undefined ? args.label : current.label},
                        issuer = ${args.issuer !== undefined ? args.issuer : current.issuer},
                        issuer_url = ${args.issuerUrl !== undefined ? args.issuerUrl : current.issuer_url},
                        stock_variant_tier = ${
                            args.stockVariantTier !== undefined ? args.stockVariantTier : current.stock_variant_tier
                        },
                        is_active = ${args.isActive !== undefined ? args.isActive : current.is_active},
                        updated_at = ${new Date(args.nowMs)}
                    WHERE id = ${current.id}
                `;

                if (
                    args.marketSymbol !== undefined ||
                    args.marketName !== undefined ||
                    args.marketLogoURI !== undefined
                ) {
                    const market = await tx<
                        Array<{ symbol: string | null; name: string | null; logo_uri: string | null }>
                    >`
                        SELECT symbol, name, logo_uri FROM variant_markets_latest
                        WHERE mint = ${args.mint} LIMIT 1 FOR UPDATE
                    `;
                    if (market[0]) {
                        const m = market[0];
                        await tx`
                            UPDATE variant_markets_latest SET
                                symbol = ${args.marketSymbol !== undefined ? args.marketSymbol : m.symbol},
                                name = ${args.marketName !== undefined ? args.marketName : m.name},
                                logo_uri = ${args.marketLogoURI !== undefined ? args.marketLogoURI : m.logo_uri}
                            WHERE mint = ${args.mint}
                        `;
                    }
                }
                return 'updated' as const;
            });
        },

        async deleteVariant(args) {
            return await sql.begin(async tx => {
                const rows = await tx<Array<{ id: string }>>`
                    SELECT id FROM asset_variants WHERE mint = ${args.mint} ORDER BY id ASC LIMIT 1 FOR UPDATE
                `;
                const variant = rows[0];
                if (!variant) return 'not_found' as const;
                await tx`DELETE FROM variant_markets_latest WHERE mint = ${args.mint}`;
                await tx`DELETE FROM token_markets_latest WHERE mint = ${args.mint}`;
                await tx`DELETE FROM asset_variants WHERE id = ${variant.id}`;
                return 'deleted' as const;
            });
        },

        async deactivateVariant(args) {
            return await sql.begin(async tx => {
                const rows = await tx<Array<{ id: string }>>`
                    SELECT id FROM asset_variants WHERE mint = ${args.mint} ORDER BY id ASC LIMIT 1 FOR UPDATE
                `;
                const variant = rows[0];
                if (!variant) return 'not_found' as const;
                await tx`
                    UPDATE asset_variants
                    SET is_active = ${args.isActive}, updated_at = ${new Date(args.nowMs)}
                    WHERE id = ${variant.id}
                `;
                return 'updated' as const;
            });
        },

        async moveVariantToCanonical(args) {
            return await sql.begin(async tx => {
                const rows = await tx<Array<{ id: string; asset_id: string; variant_id: string }>>`
                    SELECT id, asset_id, variant_id FROM asset_variants
                    WHERE mint = ${args.mint} ORDER BY id ASC LIMIT 1 FOR UPDATE
                `;
                const variant = rows[0];
                if (!variant) return { status: 'variant_not_found' as const };

                const target = await tx`SELECT 1 FROM assets WHERE asset_id = ${args.toAssetId} LIMIT 1`;
                if (target.length === 0) return { status: 'asset_not_found' as const };

                if (variant.asset_id === args.toAssetId) {
                    return { status: 'noop' as const, fromAssetId: variant.asset_id };
                }

                const collision = await tx`
                    SELECT 1 FROM asset_variants
                    WHERE asset_id = ${args.toAssetId} AND variant_id = ${variant.variant_id}
                    LIMIT 1
                `;
                if (collision.length > 0) return { status: 'variant_id_collision' as const };

                await tx`
                    UPDATE asset_variants
                    SET asset_id = ${args.toAssetId}, updated_at = ${new Date(args.nowMs)}
                    WHERE id = ${variant.id}
                `;
                return { status: 'moved' as const, fromAssetId: variant.asset_id };
            });
        },

        async removeFromCategory(args) {
            const result = await sql`
                DELETE FROM asset_collection_members
                WHERE asset_id = ${args.assetId} AND collection_slug = ${args.slug}
            `;
            return result.count > 0;
        },
        async updateCollectionMeta(args) {
            const now = new Date(args.nowMs);
            // Partial update via CASE over plain parameters (not SQL fragments):
            // an omitted field keeps the stored value, while `description: null`
            // explicitly clears it — so editing a title never blanks the
            // description and vice versa. The INSERT branch covers fresh
            // environments where the collection row does not exist yet.
            const setTitle = args.title !== undefined;
            const setDescription = args.description !== undefined;
            await sql`
                INSERT INTO asset_collections (id, slug, title, description, created_at, updated_at)
                VALUES (
                    ${randomId('acl')},
                    ${args.slug},
                    ${args.title ?? CURATED_LIST_FALLBACK_NAMES[args.slug]},
                    ${args.description ?? null},
                    ${now},
                    ${now}
                )
                ON CONFLICT (slug) DO UPDATE SET
                    title = CASE WHEN ${setTitle} THEN ${args.title ?? null}::text ELSE asset_collections.title END,
                    description = CASE
                        WHEN ${setDescription} THEN ${args.description ?? null}::text
                        ELSE asset_collections.description
                    END,
                    updated_at = ${now}
            `;
        },
    };
}
