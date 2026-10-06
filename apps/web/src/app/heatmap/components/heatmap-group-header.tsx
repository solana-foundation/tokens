import { formatUsdCompact } from '../lib/labels';
import type { LayoutGroup } from '../lib/treemap';

/** A group's label strip: name, total volume, count. Sectors are clickable; variant groups are not. */
export function GroupHeader({
    group,
    onOpenSector,
}: {
    group: LayoutGroup;
    /** Absent where the group is not a sector (variant categories inside an asset). */
    onOpenSector?: (sectorId: string) => void;
}) {
    const style = { left: group.rect.x, top: group.rect.y, width: group.rect.w, height: group.headerHeight };
    const label = (
        <>
            <span className="truncate font-semibold text-text-extra-high">{group.label}</span>
            {group.total > 0 && group.rect.w >= 150 ? (
                <span className="shrink-0 tabular-nums text-text-low">{formatUsdCompact(group.total)}</span>
            ) : null}
            {group.rect.w >= 210 ? (
                <span className="shrink-0 tabular-nums text-text-extra-low">{group.itemCount}</span>
            ) : null}
        </>
    );
    const className = 'absolute flex items-center gap-2 overflow-hidden px-0.5 pb-1 text-left text-[12px] leading-none';

    if (!onOpenSector) {
        return (
            <div className={className} style={style}>
                {label}
            </div>
        );
    }

    return (
        <button
            type="button"
            data-sector-header={group.id}
            aria-label={`${group.label}, ${group.itemCount} assets. Show this category.`}
            className={`${className} rounded-sm outline-none hover:[&>span:first-child]:underline focus-visible:ring-2 focus-visible:ring-gray-1400`}
            style={style}
            onClick={() => onOpenSector(group.id)}
        >
            {label}
        </button>
    );
}
