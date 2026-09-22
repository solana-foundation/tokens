import sharp from 'sharp';

/** Fixed output: 256x256 WebP, transparent letterbox for non-square art. */
export const LOGO_SIZE = 256;
export const LOGO_OUTPUT_CONTENT_TYPE = 'image/webp';

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';

/**
 * Magic-byte detection (port of apps/web image-proxy). Upstream
 * `content-type` headers are routinely wrong (`application/octet-stream`,
 * `text/plain` for SVG), so the bytes decide.
 */
export function sniffImageContentType(bytes: Uint8Array): SniffedImageType | null {
    if (bytes.length < 12) return null;

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
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
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

    try {
        const head = new TextDecoder('utf-8', { fatal: false })
            .decode(bytes.subarray(0, Math.min(bytes.length, 2048)))
            .replace(/^\uFEFF/, '')
            .trimStart()
            .toLowerCase();
        if (
            (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype') || head.startsWith('<!--')) &&
            head.includes('<svg')
        ) {
            return 'image/svg+xml';
        }
    } catch {
        // not text
    }
    return null;
}

export interface NormalizedLogo {
    webp: Uint8Array;
    width: number;
    height: number;
}

export interface LogoNormalizer {
    /** Decode (rasterising SVG), fit into LOGO_SIZE square, encode WebP. Throws on undecodable input. */
    normalize(bytes: Uint8Array, contentType: SniffedImageType): Promise<NormalizedLogo>;
}

export class LogoNormalizeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LogoNormalizeError';
    }
}

const LIMIT_INPUT_PIXELS = 40_000_000;
/** SVGs have no intrinsic pixel size; render dense first so downsampling stays crisp. */
const SVG_DENSITY = 300;

async function encode(input: Uint8Array, density: number | undefined): Promise<NormalizedLogo> {
    const pipeline = sharp(Buffer.from(input), {
        animated: false,
        limitInputPixels: LIMIT_INPUT_PIXELS,
        ...(density !== undefined ? { density } : {}),
    });
    const { data, info } = await pipeline
        .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 85, effort: 4 })
        .toBuffer({ resolveWithObject: true });
    return { webp: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

export function makeSharpLogoNormalizer(): LogoNormalizer {
    return {
        async normalize(bytes, contentType) {
            try {
                if (contentType === 'image/svg+xml') {
                    try {
                        return await encode(bytes, SVG_DENSITY);
                    } catch {
                        // Oversized viewBox at high density trips limitInputPixels; retry at the default DPI.
                        return await encode(bytes, undefined);
                    }
                }
                return await encode(bytes, undefined);
            } catch (err) {
                throw new LogoNormalizeError(err instanceof Error ? err.message : String(err));
            }
        },
    };
}
