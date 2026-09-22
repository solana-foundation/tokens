import { Storage } from '@google-cloud/storage';

export interface LogoStorePutOptions {
    contentType: string;
    cacheControl?: string;
    /** Custom object metadata (e.g. `source-hash`, `source-url`). */
    metadata?: Record<string, string>;
}

export interface LogoStore {
    put(key: string, bytes: Uint8Array, opts: LogoStorePutOptions): Promise<void>;
    publicUrl(key: string): string;
}

/**
 * Public asset-logo bucket (`tokens-asset-logos-<env>`), written with the
 * runtime service account's Application Default Credentials. The bucket has
 * uniform bucket-level access with `allUsers` objectViewer, so objects are
 * public without per-object ACLs (same bucket cloudrun-admin signs uploads
 * for; see apps/cloudrun-admin/src/gcs.ts).
 */
export function makeGcsLogoStore(bucket: string, publicBaseUrl?: string): LogoStore {
    const storage = new Storage();
    const base = (publicBaseUrl?.trim() || `https://storage.googleapis.com/${bucket}`).replace(/\/$/, '');
    return {
        async put(key, bytes, opts) {
            await storage
                .bucket(bucket)
                .file(key)
                .save(Buffer.from(bytes), {
                    resumable: false,
                    contentType: opts.contentType,
                    metadata: {
                        contentType: opts.contentType,
                        ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
                        ...(opts.metadata ? { metadata: opts.metadata } : {}),
                    },
                });
        },
        publicUrl(key) {
            return `${base}/${key}`;
        },
    };
}
