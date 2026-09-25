import { NextResponse } from 'next/server';
import { extractIpfsRef } from '@/lib/ipfs-ref';
import { buildAllowedRemoteHosts, fetchWithValidatedRedirects, isAllowedRemoteHost } from '../_remote-asset-fetch';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB (logos only)

function sniffImageContentType(bytes: Uint8Array): string | null {
    if (bytes.length < 12) return null;

    // PNG
    if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return 'image/png';
    }

    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }

    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }

    // WEBP: "RIFF" .... "WEBP"
    if (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp';
    }

    // SVG: check for "<svg" in the first ~1KB (handles XML prolog / whitespace).
    try {
        const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
        const normalized = head
            .replace(/^\uFEFF/, '')
            .trimStart()
            .toLowerCase();
        if (normalized.startsWith('<svg') || normalized.startsWith('<?xml') || normalized.startsWith('<!doctype')) {
            if (normalized.includes('<svg')) return 'image/svg+xml';
        }
    } catch {
        // ignore
    }

    return null;
}

function resolveIpfsTarget(src: string): { url: URL; headers: Record<string, string> } | null {
    const ref = extractIpfsRef(src);
    const host = process.env.PINATA_GATEWAY_HOST?.trim()
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '');
    if (!ref || !host) return null;
    const token = process.env.PINATA_GATEWAY_TOKEN?.trim();
    return {
        url: new URL(`https://${host}/ipfs/${ref.cid}${ref.path}`),
        headers: token ? { 'x-pinata-gateway-token': token } : {},
    };
}

export async function GET(request: Request): Promise<Response> {
    const { searchParams } = new URL(request.url);
    const src = (searchParams.get('src') ?? '').trim();
    const fresh = searchParams.get('fresh') === '1';

    if (!src) {
        return NextResponse.json({ error: 'Missing src parameter' }, { status: 400 });
    }

    const allowedHosts = buildAllowedRemoteHosts();
    const upstreamHeaders: Record<string, string> = { Accept: 'image/*,*/*;q=0.8' };

    let target: URL;
    if (/^ipfs:\/\//i.test(src)) {
        // `ipfs://<cid>[/path]` is served through our dedicated Pinata gateway; public gateways
        // 429/403 everyone. The gateway token stays server-side.
        const resolved = resolveIpfsTarget(src);
        if (!resolved) {
            return NextResponse.json({ error: 'IPFS gateway not configured' }, { status: 404 });
        }
        target = resolved.url;
        Object.assign(upstreamHeaders, resolved.headers);
        allowedHosts.add(target.hostname);
    } else {
        try {
            target = new URL(src);
        } catch {
            return NextResponse.json({ error: 'Invalid src URL' }, { status: 400 });
        }

        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 });
        }

        if (!isAllowedRemoteHost(target.hostname, allowedHosts)) {
            return NextResponse.json({ error: 'Host not allowed' }, { status: 403 });
        }
    }

    try {
        const upstream = await fetchWithValidatedRedirects(
            target,
            {
                headers: upstreamHeaders,
                cache: fresh ? 'no-store' : 'force-cache',
            },
            allowedHosts,
        );

        if (!upstream.ok) {
            return NextResponse.json({ error: 'Failed to fetch image' }, { status: upstream.status || 502 });
        }

        const contentLength = Number(upstream.headers.get('content-length') ?? '0');
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
            return NextResponse.json({ error: 'Image too large' }, { status: 413 });
        }

        const bytes = new Uint8Array(await upstream.arrayBuffer());
        if (bytes.byteLength === 0) {
            return NextResponse.json({ error: 'Empty image' }, { status: 502 });
        }
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
            return NextResponse.json({ error: 'Image too large' }, { status: 413 });
        }

        const contentTypeRaw = upstream.headers.get('content-type') ?? 'application/octet-stream';
        const headerContentType = contentTypeRaw.split(';')[0]?.trim().toLowerCase() ?? '';
        const sniffed = sniffImageContentType(bytes);
        const effectiveContentType = headerContentType.startsWith('image/') ? headerContentType : sniffed;
        if (!effectiveContentType) {
            return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
        }

        return new Response(bytes, {
            status: 200,
            headers: {
                'Content-Type': effectiveContentType,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': fresh
                    ? 'no-store, no-cache, must-revalidate'
                    : 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
            },
        });
    } catch {
        return NextResponse.json({ error: 'Failed to proxy image' }, { status: 502 });
    }
}
