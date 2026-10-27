/**
 * Response policy shared by every path that serves third-party image bytes from our origin
 * (`next/image` optimizer config and the `/api/image-proxy` route handler).
 *
 * The CSP sandbox and attachment disposition keep the bytes inert if the URL is ever opened
 * directly as a document; neither header affects `<img>` or `fetch()` subresource loads.
 */
export const IMAGE_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'none'; object-src 'none'; sandbox;";

export const IMAGE_CONTENT_DISPOSITION_TYPE = 'attachment' as const;

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
};

export function imageContentDisposition(contentType: string): string {
    const ext = EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()] ?? 'img';
    return `${IMAGE_CONTENT_DISPOSITION_TYPE}; filename="image.${ext}"`;
}

export function buildImageResponseHeaders(contentType: string, cacheControl: string): Record<string, string> {
    return {
        'Content-Type': contentType,
        'Content-Disposition': imageContentDisposition(contentType),
        'Content-Security-Policy': IMAGE_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': cacheControl,
    };
}
