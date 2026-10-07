import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';

import type { HeatmapAsset, HeatmapData, HeatmapSector, HeatmapVariant } from './types';

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export type LayoutTile =
    | { kind: 'asset'; key: string; rect: Rect; value: number; asset: HeatmapAsset }
    | { kind: 'variant'; key: string; rect: Rect; value: number; variant: HeatmapVariant; assetId: string }
    /** Stand-in for every tile of the group that is too small to draw at this zoom level. */
    | { kind: 'more'; key: string; rect: Rect; value: number; groupId: string; count: number };

export interface LayoutGroup {
    id: string;
    label: string;
    rect: Rect;
    /** Height reserved at the top of `rect` for the group label; 0 when it does not fit. */
    headerHeight: number;
    /** 24h volume summed across the whole group, including merged tiles. */
    total: number;
    itemCount: number;
    tiles: LayoutTile[];
}

export type HeatmapLevel = 'overview' | 'sector' | 'asset';

export interface HeatmapLayout {
    level: HeatmapLevel;
    width: number;
    height: number;
    groups: LayoutGroup[];
}

/**
 * Tile area follows volume ** TILE_EXPONENT rather than raw volume. On Solana
 * one asset per sector (SOL, USD) carries ~95% of the volume, so proportional
 * tiles would leave everything else a sliver; the square root keeps the order
 * and the sense of scale while leaving room to read the rest. Set to 1 for
 * strictly proportional areas.
 */
export const TILE_EXPONENT = 0.5;
/**
 * No tile takes more than this share of its map. Compression alone leaves USD at ~95% of
 * Currencies (it out-trades EUR a thousandfold); the cap gives the rest of the map room.
 */
export const MAX_TILE_SHARE = 0.5;

/**
 * Sector areas are compressed further (share ∝ total^exponent, never below
 * `floor`): raw sector totals differ by four orders of magnitude.
 */
export const OVERVIEW_BALANCE = { exponent: 0.35, floor: 0.03 } as const;
/** Variant groups inside one asset: stronger compression, every group stays readable. */
export const ASSET_BALANCE = { exponent: 0.4, floor: 0.08, countShare: 0.6 } as const;

export const GROUP_HEADER_HEIGHT = 24;
const GROUP_HEADER_MIN_WIDTH = 64;
const GROUP_HEADER_MIN_HEIGHT = 52;
const GROUP_GAP = 8;
/** 2px surface gap between fills. */
const TILE_GAP = 2;

/** Overview: tiles smaller than this are merged into the group's "+N more" tile. */
const MIN_TILE_SIDE = 10;
const MIN_TILE_AREA = 200;
const MORE_TILE_MIN_AREA = 52 * 28;
const MORE_TILE_MIN_SIDE = 20;
/** Equal-size fallback (no group member traded in the period): smallest tile worth drawing. */
const EQUAL_TILE_MIN_AREA = 34 * 26;
/** Sector and asset views enlarge small tiles to these areas instead of merging them, so nothing is hidden. */
const SECTOR_TILE_MIN_AREA = 36 * 26;
const VARIANT_TILE_MIN_AREA = 68 * 46;
/**
 * A variant view exists to compare variants, and one often out-trades the rest ten-thousand-fold
 * (SKHY $2.6M vs SKHYx $9). Each variant gets at least this share of its group.
 */
const VARIANT_TILE_MIN_SHARE = 0.1;
/** An enlarged tile's short side must reach this fraction of the square root of its minimum area. */
const LIFT_MIN_SIDE_RATIO = 0.45;
const MERGE_PASSES = 8;

interface LayoutItem<T> {
    key: string;
    value: number;
    data: T;
}

interface GroupInput<T> {
    id: string;
    label: string;
    items: Array<LayoutItem<T>>;
}

interface ComputedGroup<T> {
    id: string;
    label: string;
    rect: Rect;
    headerHeight: number;
    total: number;
    itemCount: number;
    shown: Array<{ item: LayoutItem<T>; rect: Rect }>;
    merged: Array<LayoutItem<T>>;
    moreRect: Rect | null;
    moreValue: number;
}

interface ComputeOptions {
    width: number;
    height: number;
    /** Draw group labels even for a single group (defaults to: only when there are several). */
    header?: boolean;
    balance: Balance;
    /**
     * Fold unreadably small tiles into "+N more", or enlarge them to at least `minArea` px² and
     * `minShare` of their group (never past half the group in total, so the leaders stay leaders).
     */
    overflow: { mode: 'merge' } | { mode: 'lift'; minArea: number; minShare?: number };
}

interface TreeNode {
    groupIndex?: number;
    itemIndex?: number;
    isMore?: boolean;
    area?: number;
    children?: TreeNode[];
}

function tileWeight(value: number | null | undefined): number {
    const volume = sanitize(value);
    return volume > 0 ? volume ** TILE_EXPONENT : 0;
}

function sanitize(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

interface Balance {
    exponent: number;
    /** Minimum share of the stage for any group. */
    floor: number;
    /**
     * Also floor each group at this multiple of its share of the items (capped at half the stage):
     * a group holding most of the variants needs the room to show them, whatever its volume.
     */
    countShare?: number;
}

/**
 * Group areas: share ∝ total^exponent, then water-filled so every group gets at least its floor.
 * Groups under their floor are pinned at it and the rest is shared out by weight, so a floor is
 * met exactly instead of being diluted by renormalising.
 */
function groupShares(totals: number[], counts: number[], balance: Balance): number[] {
    const n = totals.length;
    if (n === 1) return [1];

    const raw = totals.map(total => (total > 0 ? total ** balance.exponent : 0));
    const rawSum = raw.reduce((sum, value) => sum + value, 0);
    const base = raw.map(value => (rawSum > 0 ? value / rawSum : 1 / n));
    const countSum = counts.reduce((sum, value) => sum + value, 0);
    const floors = counts.map(count => {
        const byCount = balance.countShare && countSum > 0 ? Math.min(0.5, (balance.countShare * count) / countSum) : 0;
        // Never above an even split, so the floors always fit.
        return Math.min(1 / n, Math.max(balance.floor, byCount));
    });

    const pinned = new Set<number>();
    let shares = base;
    for (let pass = 0; pass < n; pass++) {
        const pinnedShare = [...pinned].reduce((sum, index) => sum + floors[index]!, 0);
        const freeWeight = base.reduce((sum, value, index) => (pinned.has(index) ? sum : sum + value), 0);
        const freeCount = n - pinned.size;
        shares = base.map((value, index) => {
            if (pinned.has(index)) return floors[index]!;
            return freeWeight > 0 ? (value / freeWeight) * (1 - pinnedShare) : (1 - pinnedShare) / freeCount;
        });
        const under = shares
            .map((share, index) => index)
            .filter(index => !pinned.has(index) && shares[index]! < floors[index]!);
        if (under.length === 0) break;
        for (const index of under) pinned.add(index);
    }
    return shares;
}

function hasHeader(width: number, height: number): boolean {
    return width >= GROUP_HEADER_MIN_WIDTH && height >= GROUP_HEADER_MIN_HEIGHT;
}

function compute<T>(inputs: Array<GroupInput<T>>, options: ComputeOptions): Array<ComputedGroup<T>> {
    const { width, height } = options;
    const groups = inputs.filter(group => group.items.length > 0);
    if (groups.length === 0 || width <= 0 || height <= 0) return [];

    const totals = groups.map(group => group.items.reduce((sum, item) => sum + sanitize(item.value), 0));
    const shares = groupShares(
        totals,
        groups.map(group => group.items.length),
        options.balance,
    );
    const showHeaders = options.header ?? groups.length > 1;

    // Per-group working state: tiles to draw (largest first) and tiles folded into "+N more".
    const state = groups.map((group, index) => {
        const total = totals[index] ?? 0;
        const weightTotal = group.items.reduce((sum, item) => sum + tileWeight(item.value), 0);
        const area = (shares[index] ?? 0) * width * height;
        const sorted = [...group.items].sort((a, b) => sanitize(b.value) - sanitize(a.value));
        const base = {
            group,
            total,
            weightTotal,
            area,
            moreMinArea: Math.min(MORE_TILE_MIN_AREA, area * 0.5),
            liftArea:
                options.overflow.mode === 'lift'
                    ? Math.max(options.overflow.minArea, area * (options.overflow.minShare ?? 0))
                    : 0,
        };

        if (options.overflow.mode === 'lift') return { ...base, equal: total <= 0, shown: sorted, merged: [] };

        if (total <= 0) {
            // Nothing to size by: equal tiles, as many as stay readable.
            const capacity = Math.max(1, Math.floor(area / EQUAL_TILE_MIN_AREA));
            return { ...base, equal: true, shown: sorted.slice(0, capacity), merged: sorted.slice(capacity) };
        }

        return {
            ...base,
            equal: false,
            shown: sorted.filter(item => sanitize(item.value) > 0),
            merged: sorted.filter(item => sanitize(item.value) <= 0),
        };
    });

    const order = state.map((_, index) => index).sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0));

    let result: Array<ComputedGroup<T>> = [];

    for (let pass = 0; pass < MERGE_PASSES; pass++) {
        const root: TreeNode = {
            children: order.map(groupIndex => {
                const entry = state[groupIndex]!;
                // Lifted tiles may claim at most half the group, so the largest stay proportional.
                const liftFloor = Math.min(entry.liftArea, (entry.area * 0.5) / Math.max(1, entry.shown.length));

                const areas = entry.shown.map(item => {
                    if (entry.equal) return 1;
                    return Math.max((tileWeight(item.value) / entry.weightTotal) * entry.area, liftFloor);
                });
                // Cap the leader at MAX_TILE_SHARE of the whole, keeping the others' proportions.
                if (!entry.equal && areas.length > 1) {
                    const rest = areas.slice(1).reduce((sum, value) => sum + value, 0);
                    areas[0] = Math.min(areas[0]!, (rest * MAX_TILE_SHARE) / (1 - MAX_TILE_SHARE));
                }
                const mergedArea = entry.equal
                    ? entry.merged.length
                    : entry.merged.reduce(
                          (sum, item) => sum + (tileWeight(item.value) / entry.weightTotal) * entry.area,
                          0,
                      );
                const moreArea =
                    entry.merged.length === 0
                        ? 0
                        : entry.equal
                          ? Math.max(1, Math.min(mergedArea, entry.shown.length * 0.25))
                          : Math.max(mergedArea, entry.moreMinArea);

                // Rescale so the group keeps exactly its share of the map.
                const scale = entry.area / (areas.reduce((sum, value) => sum + value, 0) + moreArea);
                const children: TreeNode[] = areas.map((value, itemIndex) => ({
                    groupIndex,
                    itemIndex,
                    area: value * scale,
                }));
                if (moreArea > 0) children.push({ groupIndex, isMore: true, area: moreArea * scale });

                return { groupIndex, children };
            }),
        };

        const tree = treemap<TreeNode>()
            .tile(treemapSquarify)
            .size([width, height])
            .round(true)
            .paddingInner(node => (node.depth === 0 ? GROUP_GAP : TILE_GAP))
            .paddingTop(node =>
                showHeaders && node.depth === 1 && hasHeader(node.x1 - node.x0, node.y1 - node.y0)
                    ? GROUP_HEADER_HEIGHT
                    : 0,
            )(hierarchy(root, node => node.children).sum(node => node.area ?? 0));

        let changed = false;
        result = [];

        for (const groupNode of tree.children ?? []) {
            const groupIndex = groupNode.data.groupIndex!;
            const entry = state[groupIndex]!;
            const rect = {
                x: groupNode.x0,
                y: groupNode.y0,
                w: groupNode.x1 - groupNode.x0,
                h: groupNode.y1 - groupNode.y0,
            };

            const shown: Array<{ item: LayoutItem<T>; rect: Rect }> = [];
            const tooSmall: Array<LayoutItem<T>> = [];
            let moreRect: Rect | null = null;

            for (const leaf of groupNode.children ?? []) {
                const leafRect = { x: leaf.x0, y: leaf.y0, w: leaf.x1 - leaf.x0, h: leaf.y1 - leaf.y0 };
                if (leaf.data.isMore) {
                    moreRect = leafRect;
                    continue;
                }

                const item = entry.shown[leaf.data.itemIndex!]!;
                const unreadable =
                    Math.min(leafRect.w, leafRect.h) < MIN_TILE_SIDE || leafRect.w * leafRect.h < MIN_TILE_AREA;
                if (options.overflow.mode === 'merge' && !entry.equal && unreadable) tooSmall.push(item);
                else shown.push({ item, rect: leafRect });
            }

            if (tooSmall.length > 0) {
                changed = true;
                const dropped = new Set(tooSmall);
                entry.shown = entry.shown.filter(item => !dropped.has(item));
                entry.merged = [...tooSmall, ...entry.merged];
            }

            // Next to one dominant tile, squarify packs the rest into a thin strip: an enlarged tile can
            // have the area it was promised and still be a sliver. Grow the floor until it has a usable side.
            if (options.overflow.mode === 'lift' && shown.length > 1) {
                const minSide = Math.sqrt(options.overflow.minArea) * LIFT_MIN_SIDE_RATIO;
                const cap = (entry.area * 0.5) / shown.length;
                const hasSliver = shown.some(({ rect: tile }) => Math.min(tile.w, tile.h) < minSide);
                if (hasSliver && entry.liftArea < cap) {
                    changed = true;
                    entry.liftArea = Math.min(entry.liftArea * 1.6, cap);
                }
            }

            // Same strip problem for "+N more": grow it until it is clickable.
            const moreIsSliver = moreRect !== null && Math.min(moreRect.w, moreRect.h) < MORE_TILE_MIN_SIDE;
            if (moreIsSliver && !entry.equal && entry.moreMinArea < entry.area * 0.2) {
                changed = true;
                entry.moreMinArea = Math.min(entry.moreMinArea * 2, entry.area * 0.2);
            }

            result.push({
                id: entry.group.id,
                label: entry.group.label,
                rect,
                headerHeight: showHeaders && hasHeader(rect.w, rect.h) ? GROUP_HEADER_HEIGHT : 0,
                total: entry.total,
                itemCount: entry.group.items.length,
                shown,
                merged: entry.merged,
                moreRect,
                moreValue: entry.merged.reduce((sum, item) => sum + sanitize(item.value), 0),
            });
        }

        if (!changed) break;
    }

    return result;
}

function toLayout<T>(
    level: HeatmapLevel,
    computed: Array<ComputedGroup<T>>,
    width: number,
    height: number,
    toTile: (item: LayoutItem<T>, rect: Rect) => LayoutTile,
): HeatmapLayout {
    return {
        level,
        width,
        height,
        groups: computed.map(group => {
            const tiles = group.shown.map(({ item, rect }) => toTile(item, rect));
            if (group.moreRect && group.merged.length > 0) {
                tiles.push({
                    kind: 'more',
                    key: `more:${group.id}`,
                    rect: group.moreRect,
                    value: group.moreValue,
                    groupId: group.id,
                    count: group.merged.length,
                });
            }
            return {
                id: group.id,
                label: group.label,
                rect: group.rect,
                headerHeight: group.headerHeight,
                total: group.total,
                itemCount: group.itemCount,
                tiles,
            };
        }),
    };
}

function assetItem(asset: HeatmapAsset): LayoutItem<HeatmapAsset> {
    return { key: `asset:${asset.assetId}`, value: sanitize(asset.volume24h), data: asset };
}

function assetTile(item: LayoutItem<HeatmapAsset>, rect: Rect): LayoutTile {
    return { kind: 'asset', key: item.key, rect, value: item.value, asset: item.data };
}

/** Every sector, each filled with its canonical assets. */
export function layoutOverview(data: HeatmapData, width: number, height: number): HeatmapLayout {
    const computed = compute(
        data.sectors.map(sector => ({ id: sector.id, label: sector.label, items: sector.assets.map(assetItem) })),
        { width, height, balance: OVERVIEW_BALANCE, overflow: { mode: 'merge' } },
    );
    return toLayout('overview', computed, width, height, assetTile);
}

/** Overview as rows: the gap between category rows and the limits on a row's map height. */
const ROW_GAP = 16;
const ROW_MIN_HEIGHT = 160;
const ROW_MAX_HEIGHT = 600;

/** Room for a category's map: grows with the square root of its asset count, within limits. */
export function rowHeight(assetCount: number): number {
    return Math.round(Math.min(ROW_MAX_HEIGHT, Math.max(ROW_MIN_HEIGHT, 96 + 30 * Math.sqrt(assetCount))));
}

function shiftRect(rect: Rect, dy: number): Rect {
    return { ...rect, y: rect.y + dy };
}

function shiftGroup<T>(group: ComputedGroup<T>, dy: number): ComputedGroup<T> {
    return {
        ...group,
        rect: shiftRect(group.rect, dy),
        shown: group.shown.map(entry => ({ ...entry, rect: shiftRect(entry.rect, dy) })),
        moreRect: group.moreRect ? shiftRect(group.moreRect, dy) : null,
    };
}

/**
 * The overview as stacked rows: one full-width heat map per category, in the home page's order,
 * each with its label and a height from its asset count. The layout is as tall as the rows need.
 */
export function layoutOverviewRows(data: HeatmapData, width: number): HeatmapLayout {
    const computed: Array<ComputedGroup<HeatmapAsset>> = [];
    let y = 0;
    for (const sector of data.sectors) {
        if (sector.assets.length === 0) continue;
        const height = GROUP_HEADER_HEIGHT + rowHeight(sector.assets.length);
        const [group] = compute([{ id: sector.id, label: sector.label, items: sector.assets.map(assetItem) }], {
            width,
            height,
            header: true,
            balance: OVERVIEW_BALANCE,
            overflow: { mode: 'merge' },
        });
        if (group) computed.push(shiftGroup(group, y));
        y += height + ROW_GAP;
    }
    return toLayout('overview', computed, width, Math.max(0, y - ROW_GAP), assetTile);
}

/** One sector filling the viewport; every asset is drawn, the smallest enlarged to stay readable. */
export function layoutSector(sector: HeatmapSector, width: number, height: number): HeatmapLayout {
    const computed = compute([{ id: sector.id, label: sector.label, items: sector.assets.map(assetItem) }], {
        width,
        height,
        balance: OVERVIEW_BALANCE,
        overflow: { mode: 'lift', minArea: SECTOR_TILE_MIN_AREA },
    });
    return toLayout('sector', computed, width, height, assetTile);
}

/** One asset's variants, grouped by display category (Native / Wrapped / Bridged / …). */
export function layoutAsset(asset: HeatmapAsset, width: number, height: number): HeatmapLayout {
    const groups = new Map<string, GroupInput<HeatmapVariant> & { order: number }>();
    for (const variant of asset.variants) {
        const item = { key: `variant:${variant.id}`, value: sanitize(variant.volume24h), data: variant };
        const group = groups.get(variant.groupId);
        if (group) group.items.push(item);
        else {
            groups.set(variant.groupId, {
                id: variant.groupId,
                label: variant.groupLabel,
                order: variant.groupOrder,
                items: [item],
            });
        }
    }

    const computed = compute(
        [...groups.values()].sort((a, b) => a.order - b.order),
        {
            width,
            height,
            balance: ASSET_BALANCE,
            overflow: { mode: 'lift', minArea: VARIANT_TILE_MIN_AREA, minShare: VARIANT_TILE_MIN_SHARE },
        },
    );
    return toLayout('asset', computed, width, height, (item, rect) => ({
        kind: 'variant',
        key: item.key,
        rect,
        value: item.value,
        variant: item.data,
        assetId: asset.assetId,
    }));
}
