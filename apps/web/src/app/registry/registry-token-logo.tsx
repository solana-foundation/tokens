'use client';

import { useState } from 'react';
import Image from 'next/image';

import { normalizeLogoSrc } from '@/lib/normalize-logo-src';
import type { RegistryRow } from './lib/types';

// next/image only accepts https remote patterns; drop anything else rather than crash the row.
function renderableLogoSrc(src: string | undefined): string | undefined {
    const normalized = normalizeLogoSrc(src);
    if (!normalized) return undefined;
    return normalized.startsWith('/') || normalized.startsWith('https://') ? normalized : undefined;
}

// Logos already served by our image proxy are CDN-cached there; skip the optimizer's extra hop.
function isProxiedLogo(src: string): boolean {
    return src.startsWith('/api/image-proxy?');
}

export function RegistryTokenLogo({ row, size = 26 }: { row: RegistryRow; size?: number }) {
    const [hasError, setHasError] = useState(false);
    const symbol = row.symbol || row.name || '??';
    const initials = symbol.slice(0, 2).toUpperCase();
    const src = renderableLogoSrc(row.logoURI ?? undefined);

    if (!src || hasError) {
        return (
            <div
                className="rounded-full bg-gray-1400 flex items-center justify-center shrink-0"
                style={{ width: size, height: size }}
            >
                <span className="text-[10px] font-bold text-white">{initials}</span>
            </div>
        );
    }

    return (
        <Image
            src={src}
            alt={symbol}
            width={size}
            height={size}
            style={{ width: size, height: size }}
            className="rounded-full bg-gray-50 object-cover shrink-0"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
            unoptimized={isProxiedLogo(src)}
        />
    );
}
