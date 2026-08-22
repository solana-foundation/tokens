import 'server-only';

/**
 * Routing table for `/api/admin/[kind]/[name]`: which Cloud Run service hosts
 * each curation function, its dispatch kind, and the proxy timeout.
 *
 * Pure-Postgres queries/mutations live on cloudrun-admin; the Birdeye/seed/
 * refresh actions live on cloudrun-assets (admin-guarded there) because that
 * service owns the provider clients and refresh handlers in-process. The
 * assets-hosted actions await their warms inline, hence the longer timeouts.
 */

export interface AdminFnSpec {
    service: 'admin' | 'assets';
    kind: 'query' | 'mutation';
    timeoutMs?: number;
}

export const ADMIN_FNS: Record<string, AdminFnSpec> = {
    // cloudrun-admin queries
    listCategories: { service: 'admin', kind: 'query' },
    listCanonicalAssets: { service: 'admin', kind: 'query' },
    listVariantsByAssetIds: { service: 'admin', kind: 'query' },
    getCanonicalEditor: { service: 'admin', kind: 'query' },
    getVariantEditor: { service: 'admin', kind: 'query' },
    searchCanonicalAssets: { service: 'admin', kind: 'query' },
    previewMint: { service: 'admin', kind: 'query' },
    adminListTokenLists: { service: 'admin', kind: 'query' },

    // cloudrun-admin mutations
    createCanonicalAsset: { service: 'admin', kind: 'mutation' },
    updateCanonicalAsset: { service: 'admin', kind: 'mutation' },
    deleteCanonicalAsset: { service: 'admin', kind: 'mutation' },
    hardDeleteAsset: { service: 'admin', kind: 'mutation', timeoutMs: 60_000 },
    createVariant: { service: 'admin', kind: 'mutation' },
    updateVariant: { service: 'admin', kind: 'mutation' },
    deleteVariant: { service: 'admin', kind: 'mutation' },
    deactivateVariant: { service: 'admin', kind: 'mutation' },
    moveVariantToCanonical: { service: 'admin', kind: 'mutation' },
    removeFromCategory: { service: 'admin', kind: 'mutation' },
    generateCanonicalLogoUploadUrl: { service: 'admin', kind: 'mutation' },
    adminArchiveTokenList: { service: 'admin', kind: 'mutation' },

    // cloudrun-assets admin actions (awaited warms → long timeouts)
    adminCheckVariantMintForCanonical: { service: 'assets', kind: 'mutation', timeoutMs: 30_000 },
    adminAddCheckedVariant: { service: 'assets', kind: 'mutation', timeoutMs: 60_000 },
    adminSeedAsset: { service: 'assets', kind: 'mutation', timeoutMs: 60_000 },
    adminRefreshChartData: { service: 'assets', kind: 'mutation', timeoutMs: 60_000 },
};
