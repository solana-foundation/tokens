import { getImageProps } from 'next/image';

import { detailFor, faceFor, LOGO_SOURCE_SIZE } from './tile-face';
import type { HeatmapLayout } from './treemap';

const preloaded = new Set<string>();
const MAX_PRELOADS_PER_LAYOUT = 48;

/**
 * Warm the browser cache with the logos `layout` will draw, using the same optimizer URLs the
 * tiles request, so a view opens with its logos in place. Browser only.
 */
export function preloadTileLogos(layout: HeatmapLayout): void {
    let started = 0;
    for (const group of layout.groups) {
        for (const tile of group.tiles) {
            if (tile.kind === 'more' || detailFor(tile.rect.w, tile.rect.h) !== 'full') continue;
            const src = faceFor(tile).logoURI;
            if (!src || preloaded.has(src)) continue;
            preloaded.add(src);

            const { props } = getImageProps({ src, alt: '', width: LOGO_SOURCE_SIZE, height: LOGO_SOURCE_SIZE });
            const image = new window.Image();
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            if (props.srcSet) image.srcset = props.srcSet;
            image.src = props.src;
            if (++started >= MAX_PRELOADS_PER_LAYOUT) return;
        }
    }
}
