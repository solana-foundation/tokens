'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    IconChevronDown,
    IconChevronRight,
    IconEllipsis,
    IconMagnifyingglass,
    IconPencil,
    IconPlusCircleFill,
    IconSliderHorizontal3,
    IconTrayAndArrowDown,
} from 'symbols-react';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type PaginationState,
    type SortingState,
} from '@tanstack/react-table';

import { useAdminMutation, useAdminQuery, useIsAdmin } from '@/hooks/use-admin-api';
import type {
    AdminVariantRow,
    CanonicalRow,
    CategoryRow,
    CuratedCategorySlug,
    DeactivateVariantResult,
    DeleteCanonicalAssetResult,
    DeleteVariantResult,
    RefreshChartDataResult,
    RemoveFromCategoryResult,
    VariantsByAssetIdRow,
} from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { Spinner } from '@tokens/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Skeleton } from '@tokens/ui/skeleton';
import { Badge } from '@solana/design-system/badge';
import {
    Table,
    TableBody,
    TableCell,
    TableCellCopyable,
    TableHead,
    TableHeader,
    TableRow,
} from '@solana/design-system/table';
import { SeedDialog } from './seed-dialog';
import { RemoveConfirmDialog } from './remove-confirm-dialog';
import { HardDeleteAssetDialog } from './hard-delete-asset-dialog';
import { CreateCanonicalDialog } from './create-canonical-dialog';
import { EditCanonicalDialog } from './edit-canonical-dialog';
import { EditCategoriesDialog } from './edit-categories-dialog';
import { AddVariantDialog } from './add-variant-dialog';
import { EditVariantDialog } from './edit-variant-dialog';
import { MoveVariantDialog } from './move-variant-dialog';

type VariantRow = AdminVariantRow;

const columnHelper = createColumnHelper<CanonicalRow>();

const CATEGORY_LABELS: Record<string, string> = {
    crypto: 'Crypto',
    stablecoin: 'Stablecoin',
    lst: 'LST',
    rwa: 'RWA',
    commodity: 'Commodity',
    equity: 'Equity',
    etf: 'ETF',
    index: 'Index',
};

const COLLECTION_LABELS: Record<string, string> = {
    majors: 'Majors',
    currencies: 'Currencies',
    rwas: 'RWAs',
    etfs: 'ETFs',
    metals: 'Metals',
    stocks: 'Stocks',
};

function SortIndicator({ direction }: { direction: false | 'asc' | 'desc' }) {
    if (direction === 'asc') return <span aria-hidden="true">↑</span>;
    if (direction === 'desc') return <span aria-hidden="true">↓</span>;
    return (
        <span aria-hidden="true" className="opacity-40">
            ↕
        </span>
    );
}

function VariantRows({
    variants,
    isPrefetching,
    isAdmin,
    isRefreshingMint,
    onRefreshCharts,
    onEditVariant,
    onMoveVariant,
    onToggleVariant,
    onDeleteVariant,
}: {
    variants: VariantRow[] | undefined;
    isPrefetching: boolean;
    isAdmin: boolean | undefined;
    isRefreshingMint: string | null;
    onRefreshCharts: (mint: string) => Promise<void>;
    onEditVariant: (mint: string) => void;
    onMoveVariant: (mint: string) => void;
    onToggleVariant: (mint: string, isActive: boolean) => Promise<void>;
    onDeleteVariant: (mint: string) => Promise<void>;
}): React.JSX.Element {
    if (variants === undefined) {
        return (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" /> {isPrefetching ? 'Preparing variants…' : 'Loading variants…'}
            </div>
        );
    }

    if (variants.length === 0) {
        return <div className="py-4 text-sm text-muted-foreground">No variants yet.</div>;
    }

    return (
        <div className="space-y-3 py-3">
            {variants.map(variant => {
                const variantName = variant.name ?? variant.label ?? variant.symbol ?? variant.variantId;
                return (
                    <div
                        key={variant.mint}
                        className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3"
                    >
                        <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-8 w-8">
                                {variant.logoURI ? (
                                    <AvatarImage src={variant.logoURI} alt={variant.symbol ?? variant.variantId} />
                                ) : null}
                                <AvatarFallback className="text-[10px]">
                                    {(variant.symbol ?? variant.variantId).slice(0, 2)}
                                </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="truncate font-inter-medium">
                                        {variant.symbol ?? variant.label ?? '—'}
                                    </span>
                                    {!variant.isActive ? (
                                        <Badge variant="warning" className="align-middle">
                                            inactive
                                        </Badge>
                                    ) : null}
                                </div>
                                <div className="truncate text-sm text-muted-foreground">{variantName}</div>
                            </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                            <div className="truncate text-sm">
                                <span className="font-inter-medium">Mint:</span> {variant.mint}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                                {variant.variantId}
                                {variant.issuer ? ` • ${variant.issuer}` : ''}
                            </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap gap-1">
                                <Badge variant="default">{variant.kind}</Badge>
                                <Badge variant="info">{variant.liquidityTier}</Badge>
                                {variant.stockVariantTier ? (
                                    <Badge variant="info">{variant.stockVariantTier}</Badge>
                                ) : null}
                                {variant.tags.slice(0, 3).map(tag => (
                                    <Badge key={tag} variant="info">
                                        {tag}
                                    </Badge>
                                ))}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {variant.lastFetchedAt
                                    ? new Date(variant.lastFetchedAt).toLocaleString()
                                    : 'No market refresh yet'}
                            </div>
                        </div>

                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!isAdmin}
                                        aria-label={`Open actions for ${variant.variantId}`}
                                        className="px-2"
                                    >
                                        <IconEllipsis className="h-4 w-4 fill-current" aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-56 rounded-[12px]">
                                    <DropdownMenuItem onClick={() => onEditVariant(variant.mint)}>
                                        Edit variant
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() => onRefreshCharts(variant.mint)}
                                        disabled={isRefreshingMint !== null}
                                    >
                                        {isRefreshingMint === variant.mint ? 'Refreshing charts…' : 'Refresh charts'}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => onMoveVariant(variant.mint)}>
                                        Move to canonical
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => onToggleVariant(variant.mint, !variant.isActive)}>
                                        {variant.isActive ? 'Deactivate variant' : 'Activate variant'}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onClick={() => onDeleteVariant(variant.mint)}
                                        className="text-destructive focus:text-destructive"
                                    >
                                        Delete variant
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function CurationUi(): React.JSX.Element {
    const isAdmin = useIsAdmin();
    const { data: canonicalAssets } = useAdminQuery<CanonicalRow[]>(
        'listCanonicalAssets',
        isAdmin ? { includeInactive: true } : 'skip',
    );
    const { data: categories } = useAdminQuery<CategoryRow[]>('listCategories', isAdmin ? {} : 'skip');

    const refreshChartData = useAdminMutation<RefreshChartDataResult>('adminRefreshChartData');
    const removeFromCategory = useAdminMutation<RemoveFromCategoryResult>('removeFromCategory');
    const deactivateVariant = useAdminMutation<DeactivateVariantResult>('deactivateVariant');
    const deleteVariant = useAdminMutation<DeleteVariantResult>('deleteVariant');
    const deleteCanonicalAsset = useAdminMutation<DeleteCanonicalAssetResult>('deleteCanonicalAsset');

    const [search, setSearch] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [collectionFilter, setCollectionFilter] = useState('all');
    const [showInactive, setShowInactive] = useState(false);
    const [seedDialogOpen, setSeedDialogOpen] = useState(false);
    const [createCanonicalOpen, setCreateCanonicalOpen] = useState(false);
    const [editCategoriesOpen, setEditCategoriesOpen] = useState(false);
    const [editingCanonicalId, setEditingCanonicalId] = useState<string | null>(null);
    const [editingVariantMint, setEditingVariantMint] = useState<string | null>(null);
    const [moveVariantMint, setMoveVariantMint] = useState<string | null>(null);
    const [addVariantCanonical, setAddVariantCanonical] = useState<CanonicalRow | null>(null);
    const [hardDeletingAsset, setHardDeletingAsset] = useState<{ assetId: string; symbol: string } | null>(null);
    const [removingAsset, setRemovingAsset] = useState<{ assetId: string; symbol: string; collection: string } | null>(
        null,
    );
    const [expandedAssetIds, setExpandedAssetIds] = useState<Record<string, boolean>>({});
    const [isRefreshingMint, setIsRefreshingMint] = useState<string | null>(null);
    const [sorting, setSorting] = useState<SortingState>([]);
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

    const filteredAssets = useMemo((): CanonicalRow[] => {
        if (!canonicalAssets) return [];
        const q = search.toLowerCase().trim();
        return canonicalAssets.filter(asset => {
            if (!showInactive && !asset.isActive) return false;
            if (categoryFilter !== 'all' && asset.category !== categoryFilter) return false;
            if (collectionFilter !== 'all' && !asset.collections.includes(collectionFilter)) return false;
            if (!q) return true;
            return asset.searchHints.some(hint => hint.toLowerCase().includes(q));
        });
    }, [canonicalAssets, search, categoryFilter, collectionFilter, showInactive]);

    useEffect(() => {
        setPagination(current => ({ ...current, pageIndex: 0 }));
    }, [search, categoryFilter, collectionFilter, showInactive]);

    const presentCategories = useMemo(() => {
        if (!canonicalAssets) return [];
        return [...new Set(canonicalAssets.map(asset => asset.category))].sort();
    }, [canonicalAssets]);

    const columns = useMemo(
        () => [
            columnHelper.display({
                id: 'expand',
                header: '',
                enableSorting: false,
                cell: info => {
                    const asset = info.row.original;
                    const isExpanded = !!expandedAssetIds[asset.assetId];
                    return (
                        <Button
                            variant="outline"
                            size="sm"
                            className="px-2"
                            onClick={() =>
                                setExpandedAssetIds(current => ({
                                    ...current,
                                    [asset.assetId]: !current[asset.assetId],
                                }))
                            }
                            aria-label={isExpanded ? `Collapse ${asset.assetId}` : `Expand ${asset.assetId}`}
                        >
                            {isExpanded ? (
                                <IconChevronDown className="h-4 w-4 fill-current" aria-hidden="true" />
                            ) : (
                                <IconChevronRight className="h-4 w-4 fill-current" aria-hidden="true" />
                            )}
                        </Button>
                    );
                },
            }),
            columnHelper.display({
                id: 'avatar',
                header: '',
                enableSorting: false,
                cell: info => {
                    const asset = info.row.original;
                    return (
                        <Avatar className="h-8 w-8">
                            {asset.imageUrl ? <AvatarImage src={asset.imageUrl} alt={asset.symbol} /> : null}
                            <AvatarFallback className="text-[10px]">{asset.symbol.slice(0, 2)}</AvatarFallback>
                        </Avatar>
                    );
                },
            }),
            columnHelper.accessor('symbol', {
                header: 'Canonical',
                cell: info => {
                    const asset = info.row.original;
                    return (
                        <div className="space-y-0.5">
                            <div className="font-inter-medium">
                                {asset.symbol}
                                {!asset.isActive ? (
                                    <Badge variant="warning" className="ml-1.5 align-middle">
                                        inactive
                                    </Badge>
                                ) : null}
                            </div>
                            <div className="text-sm text-muted-foreground">{asset.name}</div>
                        </div>
                    );
                },
            }),
            columnHelper.accessor('category', {
                header: 'Category',
                cell: info => <Badge variant="default">{CATEGORY_LABELS[info.getValue()] ?? info.getValue()}</Badge>,
            }),
            columnHelper.accessor('assetId', {
                header: 'Asset ID',
                cell: info => info.getValue(),
            }),
            columnHelper.accessor('variantCount', {
                header: 'Variants',
                cell: info => <span className="tabular-nums">{info.getValue()}</span>,
            }),
            columnHelper.accessor('collections', {
                header: 'Lists',
                enableSorting: false,
                cell: info =>
                    info.getValue().length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                            {info.getValue().map(slug => (
                                <Badge key={slug} variant="info">
                                    {COLLECTION_LABELS[slug] ?? slug}
                                </Badge>
                            ))}
                        </div>
                    ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                    ),
            }),
            columnHelper.accessor('lastFetchedAt', {
                header: 'Last refreshed',
                cell: info => (
                    <span className="text-xs text-muted-foreground">
                        {info.getValue() ? new Date(info.getValue()!).toLocaleString() : '—'}
                    </span>
                ),
                sortingFn: (rowA, rowB, columnId) => {
                    const a = rowA.getValue<number | undefined>(columnId) ?? 0;
                    const b = rowB.getValue<number | undefined>(columnId) ?? 0;
                    return a - b;
                },
            }),
            columnHelper.display({
                id: 'actions',
                header: 'Actions',
                enableSorting: false,
                cell: info => {
                    const asset = info.row.original;
                    return (
                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!isAdmin}
                                        aria-label={`Open actions for ${asset.symbol}`}
                                        className="px-2"
                                    >
                                        <IconEllipsis className="h-4 w-4 fill-current" aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-56 rounded-[12px]">
                                    <DropdownMenuItem onClick={() => setEditingCanonicalId(asset.assetId)}>
                                        Edit canonical
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => setAddVariantCanonical(asset)}>
                                        Add variant
                                    </DropdownMenuItem>
                                    {asset.collections.length > 0 ? <DropdownMenuSeparator /> : null}
                                    {asset.collections.map(col => (
                                        <DropdownMenuItem
                                            key={col}
                                            onClick={() =>
                                                setRemovingAsset({
                                                    assetId: asset.assetId,
                                                    symbol: asset.symbol,
                                                    collection: col,
                                                })
                                            }
                                            className="text-destructive focus:text-destructive"
                                        >
                                            Remove from {COLLECTION_LABELS[col] ?? col}
                                        </DropdownMenuItem>
                                    ))}
                                    <DropdownMenuSeparator />
                                    {asset.variantCount === 0 ? (
                                        <DropdownMenuItem
                                            onClick={async () => {
                                                try {
                                                    const result = await deleteCanonicalAsset({
                                                        assetId: asset.assetId,
                                                    });
                                                    if (result.deleted)
                                                        toast.success(`Deleted canonical ${asset.assetId}`);
                                                } catch (error) {
                                                    toast.error(error instanceof Error ? error.message : String(error));
                                                }
                                            }}
                                            className="text-destructive focus:text-destructive"
                                        >
                                            Delete canonical
                                        </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                        onClick={() =>
                                            setHardDeletingAsset({
                                                assetId: asset.assetId,
                                                symbol: asset.symbol,
                                            })
                                        }
                                        className="text-destructive focus:text-destructive"
                                    >
                                        Hard delete asset
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    );
                },
            }),
        ],
        [deleteCanonicalAsset, expandedAssetIds, isAdmin],
    );

    const table = useReactTable({
        data: filteredAssets,
        columns,
        state: { sorting, pagination },
        onSortingChange: setSorting,
        onPaginationChange: setPagination,
        getRowId: row => row.assetId,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });

    const paginatedRows = table.getRowModel().rows;
    const visiblePageAssetIds = useMemo(() => paginatedRows.map(row => row.original.assetId), [paginatedRows]);
    const { data: visiblePageVariants } = useAdminQuery<VariantsByAssetIdRow[]>(
        'listVariantsByAssetIds',
        isAdmin && visiblePageAssetIds.length > 0 ? { assetIds: visiblePageAssetIds } : 'skip',
    );
    const variantsByAssetId = useMemo(() => {
        const map = new Map<string, VariantRow[]>();
        for (const row of visiblePageVariants ?? []) {
            map.set(row.assetId, row.variants);
        }
        return map;
    }, [visiblePageVariants]);
    const isPrefetchingVariants =
        isAdmin === true && visiblePageAssetIds.length > 0 && visiblePageVariants === undefined;

    async function onRefreshCharts(mint: string) {
        const m = mint.trim();
        if (!m) return;
        setIsRefreshingMint(m);
        const toastId = toast.loading(`Queueing chart refresh for ${m.slice(0, 8)}…`);
        try {
            const res = await refreshChartData({ mint: m });
            toast.success(`Queued ${res.scheduled.join(', ')} for ${m.slice(0, 8)}…`, { id: toastId });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsRefreshingMint(null);
        }
    }

    async function onRemoveConfirm() {
        if (!removingAsset) return;
        try {
            const res = await removeFromCategory({
                slug: removingAsset.collection as CuratedCategorySlug,
                assetId: removingAsset.assetId,
            });
            if (res.removed) toast.success(`Removed ${removingAsset.symbol} from ${removingAsset.collection}`);
            else toast.message('Nothing to remove');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function onToggleVariant(mint: string, isActive: boolean) {
        try {
            const result = await deactivateVariant({ mint, isActive });
            toast.success(`${result.mint} ${result.isActive ? 'activated' : 'deactivated'}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    async function onDeleteVariant(mint: string) {
        try {
            const result = await deleteVariant({ mint });
            if (result.deleted) toast.success(`Deleted variant ${mint}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        }
    }

    const totalPages = Math.max(1, table.getPageCount());
    const columnCount = columns.length;

    return (
        <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
            <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <div className="mb-2 flex items-center gap-2">
                        {isAdmin === undefined ? (
                            <Badge variant="default" dot>
                                Checking…
                            </Badge>
                        ) : isAdmin ? (
                            <Badge variant="success" dot>
                                Admin
                            </Badge>
                        ) : (
                            <Badge variant="danger" dot>
                                Not an admin
                            </Badge>
                        )}
                    </div>
                    <h1 className="text-3xl font-inter-semibold tracking-tight">Canonical Assets</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Manage canonical assets, child variants, and curated list membership from one admin surface.
                    </p>
                </div>
            </header>

            <section className="overflow-hidden rounded-[28px] border border-border-light bg-white shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
                <div className="flex flex-col gap-4 border-b border-border-extra-light bg-gray-50/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/10">
                            <IconSliderHorizontal3 className="h-4 w-4 fill-text-medium" aria-hidden="true" />
                        </div>
                        <div>
                            <div className="text-sm font-inter-semibold text-foreground">Asset Controls</div>
                            <div className="text-xs text-muted-foreground">
                                Search, filter, and add canonical inventory.
                            </div>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            variant="outline"
                            onClick={() => setSeedDialogOpen(true)}
                            disabled={!isAdmin}
                            className="border-black/10 bg-white hover:bg-gray-50"
                        >
                            <IconTrayAndArrowDown className="h-4 w-4 fill-current" aria-hidden="true" />
                            Seed / Add Mint
                        </Button>
                        <Button onClick={() => setCreateCanonicalOpen(true)} disabled={!isAdmin} className="shadow-sm">
                            <IconPlusCircleFill className="h-4 w-4 fill-current" aria-hidden="true" />
                            Create Canonical
                        </Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 p-4 sm:p-5 lg:grid-cols-[minmax(280px,1.35fr)_repeat(3,minmax(160px,0.75fr))]">
                    <label className="group relative">
                        <span className="mb-2 block text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Search
                        </span>
                        <IconMagnifyingglass
                            className="pointer-events-none absolute bottom-[13px] left-4 h-4 w-4 fill-text-extra-low transition-colors group-focus-within:fill-text-medium"
                            aria-hidden="true"
                        />
                        <Input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Canonical, symbol, asset ID, variant, or mint"
                            className="h-12 rounded-full border-border-medium bg-white pl-11 pr-4 text-[15px] shadow-none transition-all hover:border-border-medium focus-visible:ring-4 focus-visible:ring-border-light/60"
                        />
                    </label>

                    <div>
                        <div className="mb-2 text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Category
                        </div>
                        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                            <SelectTrigger className="h-12 rounded-full border-border-medium bg-white px-4 shadow-none">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-[14px]">
                                <SelectItem value="all">All categories</SelectItem>
                                {presentCategories.map(cat => (
                                    <SelectItem key={cat} value={cat}>
                                        {CATEGORY_LABELS[cat] ?? cat}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div>
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                                Front-page list
                            </span>
                            <button
                                type="button"
                                onClick={() => setEditCategoriesOpen(true)}
                                disabled={!isAdmin}
                                className="inline-flex items-center gap-1 text-xs font-inter-semibold text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                            >
                                <IconPencil className="h-3 w-3 fill-current" aria-hidden="true" />
                                Edit
                            </button>
                        </div>
                        <Select value={collectionFilter} onValueChange={setCollectionFilter}>
                            <SelectTrigger className="h-12 rounded-full border-border-medium bg-white px-4 shadow-none">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-[14px]">
                                <SelectItem value="all">All lists</SelectItem>
                                {(categories ?? []).map(c => (
                                    <SelectItem key={c.id} value={c.id}>
                                        {c.name} ({c.count})
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div>
                        <div className="mb-2 text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Status
                        </div>
                        <Select
                            value={showInactive ? 'all' : 'active'}
                            onValueChange={v => setShowInactive(v === 'all')}
                        >
                            <SelectTrigger className="h-12 rounded-full border-border-medium bg-white px-4 shadow-none">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-[14px]">
                                <SelectItem value="all">All incl. inactive</SelectItem>
                                <SelectItem value="active">Active only</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </section>

            {canonicalAssets === undefined ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead />
                            <TableHead />
                            <TableHead>Canonical</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Asset ID</TableHead>
                            <TableHead>Variants</TableHead>
                            <TableHead>Lists</TableHead>
                            <TableHead>Last refreshed</TableHead>
                            <TableHead align="right" pinned="right">
                                Actions
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <TableRow key={i}>
                                <TableCell>
                                    <Skeleton className="h-8 w-8 rounded-md" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-8 w-8 rounded-full" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-28" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-5 w-16 rounded-full" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-40" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-8" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-5 w-20 rounded-full" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-28" />
                                </TableCell>
                                <TableCell align="right" pinned="right">
                                    <Skeleton className="ml-auto h-8 w-10" />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : filteredAssets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                        {canonicalAssets.length === 0
                            ? 'No canonical assets yet.'
                            : 'No canonical assets match the current filters.'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {canonicalAssets.length === 0
                            ? 'Create a canonical asset or seed a mint to get started.'
                            : 'Try adjusting your filters above.'}
                    </p>
                </div>
            ) : (
                <Table>
                    <TableHeader>
                        {table.getHeaderGroups().map(headerGroup => (
                            <TableRow key={headerGroup.id}>
                                {headerGroup.headers.map(header => {
                                    const align =
                                        header.column.id === 'actions'
                                            ? 'right'
                                            : header.column.id === 'variantCount'
                                              ? 'right'
                                              : undefined;
                                    const isPinned = header.column.id === 'actions';
                                    const canSort = header.column.getCanSort();
                                    const direction = header.column.getIsSorted();

                                    return (
                                        <TableHead
                                            key={header.id}
                                            align={align as 'right' | undefined}
                                            pinned={isPinned ? 'right' : undefined}
                                        >
                                            {header.isPlaceholder ? null : canSort ? (
                                                <button
                                                    type="button"
                                                    onClick={header.column.getToggleSortingHandler()}
                                                    className="inline-flex items-center gap-1 text-left hover:text-foreground"
                                                >
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    <SortIndicator direction={direction} />
                                                </button>
                                            ) : (
                                                flexRender(header.column.columnDef.header, header.getContext())
                                            )}
                                        </TableHead>
                                    );
                                })}
                            </TableRow>
                        ))}
                    </TableHeader>
                    <TableBody>
                        {paginatedRows.map(row => {
                            const asset = row.original;
                            const isExpanded = !!expandedAssetIds[asset.assetId];
                            return (
                                <Fragment key={row.id}>
                                    <TableRow className={!asset.isActive ? 'opacity-50' : undefined}>
                                        {row.getVisibleCells().map(cell => {
                                            const isActions = cell.column.id === 'actions';
                                            const isAssetId = cell.column.id === 'assetId';
                                            const isNumeric = cell.column.id === 'variantCount';

                                            if (isAssetId) {
                                                return (
                                                    <TableCellCopyable
                                                        key={cell.id}
                                                        mono
                                                        truncate={160}
                                                        value={asset.assetId}
                                                    >
                                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                    </TableCellCopyable>
                                                );
                                            }

                                            return (
                                                <TableCell
                                                    key={cell.id}
                                                    align={isActions ? 'right' : undefined}
                                                    pinned={isActions ? 'right' : undefined}
                                                    numeric={isNumeric}
                                                >
                                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                </TableCell>
                                            );
                                        })}
                                    </TableRow>
                                    {isExpanded ? (
                                        <TableRow>
                                            <TableCell colSpan={columnCount} className="bg-background">
                                                <VariantRows
                                                    variants={variantsByAssetId.get(asset.assetId)}
                                                    isPrefetching={isPrefetchingVariants}
                                                    isAdmin={isAdmin}
                                                    isRefreshingMint={isRefreshingMint}
                                                    onRefreshCharts={onRefreshCharts}
                                                    onEditVariant={setEditingVariantMint}
                                                    onMoveVariant={setMoveVariantMint}
                                                    onToggleVariant={onToggleVariant}
                                                    onDeleteVariant={onDeleteVariant}
                                                />
                                            </TableCell>
                                        </TableRow>
                                    ) : null}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            )}

            {filteredAssets.length > pagination.pageSize ? (
                <div className="mt-4 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                        Showing {pagination.pageIndex * pagination.pageSize + 1}–
                        {Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredAssets.length)} of{' '}
                        {filteredAssets.length}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            Previous
                        </Button>
                        <span className="text-muted-foreground tabular-nums">
                            {pagination.pageIndex + 1} / {totalPages}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            Next
                        </Button>
                    </div>
                </div>
            ) : null}

            <SeedDialog open={seedDialogOpen} onOpenChange={setSeedDialogOpen} />
            <CreateCanonicalDialog open={createCanonicalOpen} onOpenChange={setCreateCanonicalOpen} />
            <EditCategoriesDialog open={editCategoriesOpen} onOpenChange={setEditCategoriesOpen} />
            <EditCanonicalDialog
                assetId={editingCanonicalId}
                open={editingCanonicalId !== null}
                onOpenChange={open => {
                    if (!open) setEditingCanonicalId(null);
                }}
            />
            <AddVariantDialog
                canonical={addVariantCanonical}
                open={addVariantCanonical !== null}
                onOpenChange={open => {
                    if (!open) setAddVariantCanonical(null);
                }}
            />
            <EditVariantDialog
                mint={editingVariantMint}
                open={editingVariantMint !== null}
                onOpenChange={open => {
                    if (!open) setEditingVariantMint(null);
                }}
            />
            <MoveVariantDialog
                mint={moveVariantMint}
                open={moveVariantMint !== null}
                onOpenChange={open => {
                    if (!open) setMoveVariantMint(null);
                }}
            />
            <HardDeleteAssetDialog
                open={hardDeletingAsset !== null}
                onOpenChange={open => {
                    if (!open) setHardDeletingAsset(null);
                }}
                assetId={hardDeletingAsset?.assetId ?? ''}
                assetSymbol={hardDeletingAsset?.symbol ?? ''}
            />
            <RemoveConfirmDialog
                open={removingAsset !== null}
                onOpenChange={open => {
                    if (!open) setRemovingAsset(null);
                }}
                assetSymbol={removingAsset?.symbol ?? ''}
                assetId={removingAsset?.assetId ?? ''}
                onConfirm={onRemoveConfirm}
            />
        </div>
    );
}
