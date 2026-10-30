'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    IconChevronDown,
    IconChevronRight,
    IconEllipsis,
    IconMagnifyingglass,
    IconPlusCircleFill,
    IconSliderHorizontal3,
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
    LaunchpadCandidateRow,
    ListLaunchpadPairsResult,
    RevokeLaunchpadMintArgs,
    RevokeLaunchpadMintResult,
} from '@/lib/admin-types';
import { formatRelativeTime } from '@/lib/advisory-labels';
import {
    UNSYNCED_GROUP_KEY,
    formatCompactMint,
    formatUsdCompact,
    groupLaunchCandidates,
    isRowLive,
    launchApproverLabel,
    launchGroupLabel,
    launchGroupMatches,
    launchStatusLabel,
    launchStatusTone,
    mergePairAssets,
    stonkfunTokenUrl,
    type LaunchGroup,
} from '@/lib/launch-labels';
import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@tokens/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Skeleton } from '@tokens/ui/skeleton';
import { Badge } from '@solana/design-system/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@solana/design-system/table';

import { ApproveMintDialog, type ApproveMintContext } from './approve-mint-dialog';
import { BrowseLaunchesDialog } from './browse-launches-dialog';
import { CopyButton, TokenAvatar } from './launch-bits';
import { RevokeConfirmDialog } from './revoke-confirm-dialog';

type ShowFilter = 'all' | 'approved' | 'live' | 'unapproved' | 'pairs';

const columnHelper = createColumnHelper<LaunchGroup>();

function SortIndicator({ direction }: { direction: false | 'asc' | 'desc' }) {
    if (direction === 'asc') return <span aria-hidden="true">↑</span>;
    if (direction === 'desc') return <span aria-hidden="true">↓</span>;
    return (
        <span aria-hidden="true" className="opacity-40">
            ↕
        </span>
    );
}

function statusBadgeVariant(tone: ReturnType<typeof launchStatusTone>): 'success' | 'warning' | 'default' {
    return tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : 'default';
}

function LaunchRows({
    group,
    isAdmin,
    busyMint,
    onApprove,
    onAddMint,
    onBrowse,
    onRevoke,
}: {
    group: LaunchGroup;
    isAdmin: boolean | undefined;
    busyMint: string | null;
    onApprove: (mint: string) => void;
    onAddMint: () => void;
    onBrowse: () => void;
    onRevoke: (row: LaunchpadCandidateRow) => void;
}) {
    const nowMs = Date.now();
    if (group.rows.length === 0) {
        const label = launchGroupLabel(group);
        return (
            <div className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-muted-foreground">
                    No coins approved or synced for {label.symbol} yet. stonk.fun accepts it as a quote token, so
                    anything launched against it can be added here.
                </div>
                <div className="flex shrink-0 gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!isAdmin || group.quoteMints.length === 0}
                        onClick={onBrowse}
                    >
                        Browse stonk.fun
                    </Button>
                    <Button size="sm" disabled={!isAdmin} onClick={onAddMint}>
                        Add mint
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-3 py-3">
            {group.rows.map(row => {
                const symbol = row.symbol ?? formatCompactMint(row.mint);
                const status = launchStatusLabel(row, group.lastSyncedAt);
                const approved = row.approval !== null;
                const busy = busyMint === row.mint;
                return (
                    <div
                        key={row.mint}
                        className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3"
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <TokenAvatar imageUrl={row.logoURI} label={symbol} />
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate font-inter-medium">{symbol}</span>
                                    {approved ? (
                                        <Badge variant="success" className="align-middle">
                                            approved
                                        </Badge>
                                    ) : null}
                                    <Badge
                                        variant={statusBadgeVariant(launchStatusTone(status))}
                                        className="align-middle"
                                    >
                                        {isRowLive(row) ? 'live' : status}
                                    </Badge>
                                </div>
                                <div className="truncate text-sm text-muted-foreground">{row.name ?? '—'}</div>
                            </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 text-sm">
                                <span className="truncate font-mono text-xs" title={row.mint}>
                                    {row.mint}
                                </span>
                                <CopyButton value={row.mint} />
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                                {row.approval ? (
                                    <>
                                        {launchApproverLabel(row.approval)} ·{' '}
                                        <span title={new Date(row.approval.approvedAt).toLocaleString()}>
                                            {formatRelativeTime(row.approval.approvedAt, nowMs)}
                                        </span>
                                        {row.approval.note ? ` · “${row.approval.note}”` : ''}
                                    </>
                                ) : (
                                    'Not approved'
                                )}
                            </div>
                        </div>

                        <div className="min-w-0 space-y-1 text-sm">
                            <div className="flex flex-wrap gap-x-3">
                                <span>
                                    <span className="text-muted-foreground">Mcap</span>{' '}
                                    <span className="tabular-nums">{formatUsdCompact(row.marketCapUsd)}</span>
                                </span>
                                <span>
                                    <span className="text-muted-foreground">Vol 24h</span>{' '}
                                    <span className="tabular-nums">{formatUsdCompact(row.volume24hUsd)}</span>
                                </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {row.launchedAt
                                    ? `Launched ${formatRelativeTime(row.launchedAt, nowMs)}`
                                    : 'Launch date unknown'}
                                {row.lastSyncedAt ? ` · synced ${formatRelativeTime(row.lastSyncedAt, nowMs)}` : ''}
                            </div>
                        </div>

                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!isAdmin || busy}
                                        aria-label={`Open actions for ${symbol}`}
                                        className="px-2"
                                    >
                                        <IconEllipsis className="h-4 w-4 fill-current" aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-56 rounded-[12px]">
                                    {approved ? (
                                        <DropdownMenuItem
                                            className="text-destructive focus:text-destructive"
                                            onClick={() => onRevoke(row)}
                                        >
                                            Revoke approval…
                                        </DropdownMenuItem>
                                    ) : (
                                        <DropdownMenuItem onClick={() => onApprove(row.mint)}>
                                            Approve…
                                        </DropdownMenuItem>
                                    )}
                                    {approved ? (
                                        <DropdownMenuItem onClick={() => onApprove(row.mint)}>
                                            Edit note…
                                        </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem asChild>
                                        <a href={stonkfunTokenUrl(row.mint)} target="_blank" rel="noopener noreferrer">
                                            Open on stonk.fun
                                        </a>
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

/**
 * Allowlist for launchpad coins, grouped by the quote asset they show on.
 * The stonk.fun sync keeps every candidate quoted in a curated token with live
 * market data; only approved mints reach the launches API and the asset pages.
 */
export function LaunchesUi() {
    const isAdmin = useIsAdmin();
    const { data: candidates, error: loadError } = useAdminQuery<LaunchpadCandidateRow[]>(
        'listLaunchpadCandidates',
        isAdmin ? { limit: 500 } : 'skip',
    );
    const revokeMint = useAdminMutation<RevokeLaunchpadMintResult, RevokeLaunchpadMintArgs>('revokeLaunchpadMint');
    const listPairs = useAdminMutation<ListLaunchpadPairsResult, Record<string, never>>('adminListLaunchpadPairs');
    const [pairs, setPairs] = useState<ListLaunchpadPairsResult | null>(null);
    const [pairsError, setPairsError] = useState<string | null>(null);
    const [pairsLoading, setPairsLoading] = useState(false);

    async function loadPairs() {
        setPairsLoading(true);
        setPairsError(null);
        try {
            setPairs(await listPairs({}));
        } catch (error) {
            setPairsError(error instanceof Error ? error.message : String(error));
        } finally {
            setPairsLoading(false);
        }
    }

    useEffect(() => {
        if (isAdmin) void loadPairs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAdmin]);

    const [search, setSearch] = useState('');
    const [showFilter, setShowFilter] = useState<ShowFilter>('all');
    const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
    const [sorting, setSorting] = useState<SortingState>([]);
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 });

    const [approveOpen, setApproveOpen] = useState(false);
    const [approveMint, setApproveMint] = useState<string | null>(null);
    const [approveContext, setApproveContext] = useState<ApproveMintContext | null>(null);
    const [browseGroup, setBrowseGroup] = useState<LaunchGroup | null>(null);
    const [revokeRow, setRevokeRow] = useState<LaunchpadCandidateRow | null>(null);
    const [busyMint, setBusyMint] = useState<string | null>(null);

    const groups = useMemo(
        () => mergePairAssets(groupLaunchCandidates(candidates ?? []), pairs?.assets ?? []),
        [candidates, pairs],
    );
    const filteredGroups = useMemo(() => {
        return groups
            .map(group => {
                if (showFilter === 'all' || showFilter === 'pairs') return group;
                const rows = group.rows.filter(row =>
                    showFilter === 'approved'
                        ? row.approval !== null
                        : showFilter === 'live'
                          ? isRowLive(row)
                          : row.approval === null,
                );
                return { ...group, rows };
            })
            .filter(
                group =>
                    (showFilter === 'all' || showFilter === 'pairs' || group.rows.length > 0) &&
                    launchGroupMatches(group, search),
            )
            .filter(group => showFilter !== 'pairs' || group.rows.length === 0);
    }, [groups, search, showFilter]);

    useEffect(() => {
        setPagination(prev => (prev.pageIndex === 0 ? prev : { ...prev, pageIndex: 0 }));
    }, [search, showFilter]);

    const totals = useMemo(() => {
        let approved = 0;
        let live = 0;
        for (const row of candidates ?? []) {
            if (row.approval) approved += 1;
            if (isRowLive(row)) live += 1;
        }
        return { candidates: candidates?.length ?? 0, approved, live };
    }, [candidates]);

    function contextFor(group: LaunchGroup): ApproveMintContext | null {
        if (!group.asset) return null;
        return {
            assetId: group.asset.assetId,
            symbol: launchGroupLabel(group).symbol,
            name: group.asset.name,
            quoteMints: group.quoteMints,
        };
    }

    function openApprove(mint: string | null, context: ApproveMintContext | null = null) {
        setApproveMint(mint);
        setApproveContext(context);
        setApproveOpen(true);
    }

    async function onConfirmRevoke() {
        const row = revokeRow;
        if (!row) return;
        setBusyMint(row.mint);
        const symbol = row.symbol ?? formatCompactMint(row.mint);
        const toastId = toast.loading(`Revoking ${symbol}…`);
        try {
            const result = await revokeMint({ mint: row.mint });
            if (result.revoked) toast.success(`Revoked ${symbol}.`, { id: toastId });
            else toast.message(`${symbol} was not approved.`, { id: toastId });
            setRevokeRow(null);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setBusyMint(null);
        }
    }

    const columns = useMemo(
        () => [
            columnHelper.display({
                id: 'expand',
                enableSorting: false,
                cell: ({ row }) => {
                    const group = row.original;
                    const isExpanded = !!expandedKeys[group.key];
                    return (
                        <Button
                            variant="outline"
                            size="sm"
                            className="px-2"
                            aria-label={isExpanded ? 'Collapse' : 'Expand'}
                            onClick={() => setExpandedKeys(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
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
                cell: ({ row }) => {
                    const label = launchGroupLabel(row.original);
                    return <TokenAvatar imageUrl={row.original.asset?.imageUrl} label={label.symbol} />;
                },
            }),
            columnHelper.accessor(group => launchGroupLabel(group).symbol, {
                id: 'asset',
                header: 'Quote asset',
                cell: ({ row }) => {
                    const group = row.original;
                    const label = launchGroupLabel(group);
                    return (
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-inter-medium">{label.symbol}</span>
                                {group.key === UNSYNCED_GROUP_KEY ? (
                                    <Badge variant="warning">pending sync</Badge>
                                ) : !group.asset ? (
                                    <Badge variant="danger">not curated</Badge>
                                ) : null}
                            </div>
                            <div className="text-sm text-muted-foreground">{label.name}</div>
                        </div>
                    );
                },
            }),
            columnHelper.accessor(group => group.quoteSymbol ?? '', {
                id: 'quoteSymbol',
                header: 'Quote token',
                cell: info => {
                    const group = info.row.original;
                    return group.quoteSymbol ? (
                        <span className="inline-flex items-center gap-1">
                            <Badge variant="info">{group.quoteSymbol}</Badge>
                            {group.quoteMints.length > 1 ? (
                                <span className="text-xs text-muted-foreground">+{group.quoteMints.length - 1}</span>
                            ) : null}
                        </span>
                    ) : (
                        '—'
                    );
                },
            }),
            columnHelper.accessor(group => group.counts.candidates, {
                id: 'candidates',
                header: 'Coins',
                cell: info => <span className="tabular-nums">{info.getValue()}</span>,
            }),
            columnHelper.accessor(group => group.counts.approved, {
                id: 'approved',
                header: 'Approved',
                cell: info => <span className="tabular-nums">{info.getValue()}</span>,
            }),
            columnHelper.accessor(group => group.counts.live, {
                id: 'live',
                header: 'Live',
                cell: info => <span className="tabular-nums">{info.getValue()}</span>,
            }),
            columnHelper.accessor(group => group.volume24hUsd, {
                id: 'volume',
                header: 'Vol 24h',
                cell: info => <span className="tabular-nums">{formatUsdCompact(info.getValue())}</span>,
            }),
            columnHelper.accessor(group => group.lastSyncedAt ?? 0, {
                id: 'lastSync',
                header: 'Last sync',
                cell: info => {
                    const value = info.row.original.lastSyncedAt;
                    return (
                        <span
                            className="text-xs text-muted-foreground"
                            title={value ? new Date(value).toLocaleString() : undefined}
                        >
                            {value ? formatRelativeTime(value, Date.now()) : '—'}
                        </span>
                    );
                },
            }),
            columnHelper.display({
                id: 'actions',
                header: 'Actions',
                cell: ({ row }) => {
                    const group = row.original;
                    const label = launchGroupLabel(group);
                    return (
                        <div className="flex justify-end">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={!isAdmin}
                                        aria-label={`Open actions for ${label.symbol}`}
                                        className="px-2"
                                    >
                                        <IconEllipsis className="h-4 w-4 fill-current" aria-hidden="true" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-56 rounded-[12px]">
                                    <DropdownMenuItem
                                        disabled={group.quoteMints.length === 0}
                                        onClick={() => setBrowseGroup(group)}
                                    >
                                        Browse stonk.fun…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => openApprove(null, contextFor(group))}>
                                        Add mint…
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    );
                },
            }),
        ],
        [expandedKeys, isAdmin],
    );

    const table = useReactTable({
        data: filteredGroups,
        columns,
        state: { sorting, pagination },
        onSortingChange: setSorting,
        onPaginationChange: setPagination,
        getRowId: row => row.key,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
    });
    const paginatedRows = table.getRowModel().rows;
    const columnCount = columns.length;
    const totalPages = Math.max(1, Math.ceil(filteredGroups.length / pagination.pageSize));

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
                    <h1 className="text-3xl font-inter-semibold tracking-tight">Launchpad approvals</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Coins launched on stonk.fun against a curated token, grouped by the asset page they appear on.
                        Only approved mints are public; approved coins stay in the feed regardless of the volume
                        threshold.
                    </p>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                    <div>
                        {totals.candidates} candidates · {totals.approved} approved · {totals.live} live
                    </div>
                    <div className="text-xs">
                        {pairsLoading
                            ? 'Cross-referencing stonk.fun pairs…'
                            : pairs
                              ? `${pairs.assets.length} curated assets are stonk.fun quote tokens (${pairs.curatedPairs} of ${pairs.pairsTotal} pairs)`
                              : pairsError
                                ? `Pairs unavailable: ${pairsError}`
                                : ''}
                    </div>
                </div>
            </header>

            <section className="overflow-hidden rounded-[28px] border border-border-light bg-white shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
                <div className="flex flex-col gap-4 border-b border-border-extra-light bg-gray-50/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/10">
                            <IconSliderHorizontal3 className="h-4 w-4 fill-text-medium" aria-hidden="true" />
                        </div>
                        <div>
                            <div className="text-sm font-inter-semibold text-foreground">Launch Controls</div>
                            <div className="text-xs text-muted-foreground">
                                Search, filter, browse stonk.fun per asset, and approve mints.
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button onClick={() => openApprove(null)} disabled={!isAdmin} className="shadow-sm">
                            <IconPlusCircleFill className="h-4 w-4 fill-current" aria-hidden="true" />
                            Add Mint
                        </Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 p-4 sm:p-5 lg:grid-cols-[minmax(280px,1.35fr)_minmax(160px,0.75fr)]">
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
                            onChange={event => setSearch(event.target.value)}
                            placeholder="Asset, quote token, coin symbol, or mint"
                            className="h-12 rounded-full border-border-medium bg-white pl-11 pr-4 text-[15px] shadow-none transition-all hover:border-border-medium focus-visible:ring-4 focus-visible:ring-border-light/60"
                        />
                    </label>
                    <div>
                        <div className="mb-2 block text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            Show
                        </div>
                        <Select value={showFilter} onValueChange={value => setShowFilter(value as ShowFilter)}>
                            <SelectTrigger className="h-12 rounded-full border-border-medium bg-white px-4 shadow-none">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="rounded-[14px]">
                                <SelectItem value="all">All coins</SelectItem>
                                <SelectItem value="approved">Approved only</SelectItem>
                                <SelectItem value="live">Live only</SelectItem>
                                <SelectItem value="unapproved">Not yet approved</SelectItem>
                                <SelectItem value="pairs">Pairs without coins</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </section>

            {loadError ? (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                    {loadError.message}
                </div>
            ) : null}

            {candidates === undefined ? (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead />
                            <TableHead />
                            <TableHead>Quote asset</TableHead>
                            <TableHead>Quote token</TableHead>
                            <TableHead>Coins</TableHead>
                            <TableHead>Approved</TableHead>
                            <TableHead>Live</TableHead>
                            <TableHead>Vol 24h</TableHead>
                            <TableHead>Last sync</TableHead>
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
                                    <Skeleton className="h-4 w-8" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-8" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-8" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-16" />
                                </TableCell>
                                <TableCell>
                                    <Skeleton className="h-4 w-20" />
                                </TableCell>
                                <TableCell align="right" pinned="right">
                                    <Skeleton className="ml-auto h-8 w-10" />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : filteredGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                    <p className="text-sm text-muted-foreground">
                        {candidates.length === 0
                            ? 'No launch candidates synced yet.'
                            : 'No assets match the current filters.'}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {candidates.length === 0
                            ? 'The stonk.fun sync runs every 15 minutes. Nothing is public until a mint is approved here.'
                            : 'Try adjusting your search or the Show filter.'}
                    </p>
                </div>
            ) : (
                <>
                    <Table>
                        <TableHeader>
                            {table.getHeaderGroups().map(headerGroup => (
                                <TableRow key={headerGroup.id}>
                                    {headerGroup.headers.map(header => {
                                        const isActions = header.column.id === 'actions';
                                        const isNumeric = ['candidates', 'approved', 'live', 'volume'].includes(
                                            header.column.id,
                                        );
                                        const canSort = header.column.getCanSort();
                                        return (
                                            <TableHead
                                                key={header.id}
                                                align={isActions || isNumeric ? 'right' : undefined}
                                                pinned={isActions ? 'right' : undefined}
                                            >
                                                {header.isPlaceholder ? null : canSort ? (
                                                    <button
                                                        type="button"
                                                        className="inline-flex items-center gap-1"
                                                        onClick={header.column.getToggleSortingHandler()}
                                                    >
                                                        {flexRender(
                                                            header.column.columnDef.header,
                                                            header.getContext(),
                                                        )}
                                                        <SortIndicator direction={header.column.getIsSorted()} />
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
                                const group = row.original;
                                const isExpanded = !!expandedKeys[group.key];
                                return (
                                    <Fragment key={row.id}>
                                        <TableRow>
                                            {row.getVisibleCells().map(cell => {
                                                const isActions = cell.column.id === 'actions';
                                                const isNumeric = ['candidates', 'approved', 'live', 'volume'].includes(
                                                    cell.column.id,
                                                );
                                                return (
                                                    <TableCell
                                                        key={cell.id}
                                                        align={isActions || isNumeric ? 'right' : undefined}
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
                                                    <LaunchRows
                                                        group={group}
                                                        isAdmin={isAdmin}
                                                        busyMint={busyMint}
                                                        onApprove={mint => openApprove(mint, contextFor(group))}
                                                        onAddMint={() => openApprove(null, contextFor(group))}
                                                        onBrowse={() => setBrowseGroup(group)}
                                                        onRevoke={setRevokeRow}
                                                    />
                                                </TableCell>
                                            </TableRow>
                                        ) : null}
                                    </Fragment>
                                );
                            })}
                        </TableBody>
                    </Table>

                    {filteredGroups.length > pagination.pageSize ? (
                        <div className="mt-4 flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">
                                Showing {pagination.pageIndex * pagination.pageSize + 1}–
                                {Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredGroups.length)} of{' '}
                                {filteredGroups.length}
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
                                <span className="tabular-nums">
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
                </>
            )}

            <ApproveMintDialog
                open={approveOpen}
                onOpenChange={open => {
                    setApproveOpen(open);
                    if (!open) {
                        setApproveMint(null);
                        setApproveContext(null);
                    }
                }}
                initialMint={approveMint}
                context={approveContext}
            />
            <BrowseLaunchesDialog
                open={browseGroup !== null}
                onOpenChange={open => {
                    if (!open) setBrowseGroup(null);
                }}
                group={browseGroup}
                onApproveWithNote={mint => {
                    const ctx = browseGroup ? contextFor(browseGroup) : null;
                    setBrowseGroup(null);
                    openApprove(mint, ctx);
                }}
            />
            <RevokeConfirmDialog
                open={revokeRow !== null}
                onOpenChange={open => {
                    if (!open) setRevokeRow(null);
                }}
                symbol={revokeRow?.symbol ?? formatCompactMint(revokeRow?.mint ?? '')}
                mint={revokeRow?.mint ?? ''}
                quoteSymbol={revokeRow?.quoteAsset?.symbol ?? revokeRow?.quoteSymbol ?? null}
                isBusy={revokeRow !== null && busyMint === revokeRow.mint}
                onConfirm={() => void onConfirmRevoke()}
            />
        </div>
    );
}
