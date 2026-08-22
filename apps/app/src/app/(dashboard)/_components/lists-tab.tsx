'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import {
    IconCheckmark,
    IconCircleGridCrossFill,
    IconCommand,
    IconExclamationmarkTriangleFill,
    IconInfoCircle,
    IconK,
    IconKeySlashFill,
    IconMagnifyingglass,
    IconXmark,
} from 'symbols-react';

import { Badge } from '@tokens/ui/badge';
import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@tokens/ui/sheet';
import { Skeleton } from '@tokens/ui/skeleton';
import { Spinner } from '@tokens/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@tokens/ui/tooltip';
import { CopyButton } from '@/components/app-ui/copy-button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/app-ui/dialog';
import { EmptyState } from '@/components/global/empty-state';
import { TabNavigation } from '@/components/global/tab-navigation';
import { ComposeEndpointSheet, type ComposableList } from './compose-endpoint-dialog';
import { ListSettingsDialog } from './list-settings-dialog';
import { PencilIcon, PlusIcon, StackIcon, TrashCanFillIcon } from './icons';
import { MEMBER_GRID_TEMPLATE_COLUMNS, MemberTable } from './member-table';
import { SelectionDock } from './selection-dock';
import { BulkRemoveError, useListSelection } from './use-list-selection';
import {
    TokenIdentity,
    formatUsd,
    formatValue,
    humanize,
    shortMint,
    type SearchResult,
    type V2ListToken,
} from './token-bits';
import { TokenSearchCommand } from './token-search-command';
import { slugAvailabilityMessage, useSlugAvailability } from './use-slug-availability';
import { useProjectApiKeys } from '@/contexts/project-api-keys';
import { useDashboardTab } from '@/hooks/use-dashboard-tab';

/**
 * Community lists management: a first-party client of the public /api/v2/lists
 * API, authenticated through the playground key-reveal proxy — the same write
 * path partners use programmatically, so there is nothing dashboard-only to
 * drift. Projects without the invite-only `lists:write` scope see a
 * request-access state.
 */

interface V2ListSummary {
    slug: string;
    name: string;
    curated: boolean;
    owner: { name?: string; projectId?: string };
    tokenCount: number;
    updatedAt: number | null;
}

function MetadataStat({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 bg-background px-4 py-4 sm:px-5">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-2 truncate text-lg font-inter-semibold tabular-nums text-foreground">{value}</div>
        </div>
    );
}

function MetadataTooltipChip({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-md bg-white/5 px-1.5 py-0.5 font-berkeley-mono text-[10px] leading-4 text-white">
            {children}
        </span>
    );
}

function MetadataScoreBar({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 font-berkeley-mono text-[10px] text-muted-foreground">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                <div
                    className={`h-full rounded-full ${value >= 70 ? 'bg-emerald-500' : value >= 40 ? 'bg-amber-500' : 'bg-red-400'}`}
                    style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
                />
            </div>
            <span className="w-7 shrink-0 text-right font-berkeley-mono text-[10px] text-muted-foreground">
                {Math.round(value)}
            </span>
        </div>
    );
}

type WriteAccess = 'checking' | 'granted' | 'denied';

const LIST_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const TOKEN_METADATA_CACHE_TTL_MS = 5 * 60_000;
const CLIENT_CACHE_MAX_ENTRIES = 50;

interface CachedListTokens {
    tokens: V2ListToken[];
    cachedAt: number;
}

interface CachedTokenMetadata {
    result: SearchResult | null;
    cachedAt: number;
}

// Module-scoped so switching dashboard tabs does not discard already-loaded
// rows or their image URLs. Keys include project id to avoid cross-project data.
const listTokenCache = new Map<string, CachedListTokens>();
const tokenMetadataCache = new Map<string, CachedTokenMetadata>();

function readCacheEntry<T>(cache: Map<string, T>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    // Refresh insertion order for bounded LRU eviction.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
}

function writeCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CLIENT_CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
    }
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

/**
 * One row of the list rail. Selection is the whole-row target; settings and
 * delete ride on hover-revealed icon buttons at the trailing edge so the
 * resting state stays name + count. Delete is two-step — arming swaps the
 * actions for an explicit confirm, since it is a hard delete with no undo.
 */
function ListRailRow({
    list,
    selected,
    onSelect,
    onEdit,
    confirmingDelete,
    deleting,
    onDeleteArm,
    onDeleteCancel,
    onDeleteConfirm,
}: {
    list: V2ListSummary;
    selected: boolean;
    onSelect: () => void;
    onEdit: () => void;
    confirmingDelete: boolean;
    deleting: boolean;
    onDeleteArm: () => void;
    onDeleteCancel: () => void;
    onDeleteConfirm: () => void;
}) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect();
                }
            }}
            className={`group flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-left shadow-sm transition-colors ${
                selected
                    ? 'border-black/25 bg-gray-100/80 dark:border-white/25 dark:bg-zinc-900/60'
                    : 'border-black/[0.12] bg-white hover:border-black/20 hover:bg-gray-50/60 dark:border-white/10 dark:bg-zinc-950/30 dark:hover:bg-zinc-900/40'
            }`}
        >
            <span className="truncate text-sm font-inter-medium">{list.name}</span>
            <Badge variant="secondary" className="shrink-0 px-1.5 font-berkeley-mono text-[10px]">
                {list.tokenCount}
            </Badge>

            {confirmingDelete ? (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button
                        variant="destructive"
                        size="sm"
                        className="h-6 px-2 text-xs text-white hover:text-white"
                        disabled={deleting}
                        onClick={event => {
                            event.stopPropagation();
                            onDeleteConfirm();
                        }}
                    >
                        {deleting ? <Spinner size="sm" /> : 'Delete'}
                    </Button>
                    <IconButton
                        label="Cancel delete"
                        disabled={deleting}
                        onClick={event => {
                            event.stopPropagation();
                            onDeleteCancel();
                        }}
                    >
                        <IconXmark className="size-3 fill-muted-foreground" />
                    </IconButton>
                </div>
            ) : (
                <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                        label={`Edit ${list.name}`}
                        onClick={event => {
                            event.stopPropagation();
                            onEdit();
                        }}
                    >
                        <PencilIcon className="size-3.5 text-muted-foreground" />
                    </IconButton>
                    <IconButton
                        label={`Delete ${list.name}`}
                        onClick={event => {
                            event.stopPropagation();
                            onDeleteArm();
                        }}
                    >
                        <TrashCanFillIcon className="size-3.5 text-muted-foreground" />
                    </IconButton>
                </div>
            )}
        </div>
    );
}

/** Read-only rail pill for lists the project doesn't own (curated + other projects'). */
function CommunityRailRow({
    list,
    selected,
    onSelect,
}: {
    list: V2ListSummary;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onSelect}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect();
                }
            }}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-left shadow-sm transition-colors ${
                selected
                    ? 'border-black/25 bg-gray-100/80 dark:border-white/25 dark:bg-zinc-900/60'
                    : 'border-black/[0.12] bg-white hover:border-black/20 hover:bg-gray-50/60 dark:border-white/10 dark:bg-zinc-950/30 dark:hover:bg-zinc-900/40'
            }`}
        >
            <span className="truncate text-sm font-inter-medium">{list.name}</span>
            <Badge variant="secondary" className="shrink-0 px-1.5 font-berkeley-mono text-[10px]">
                {list.tokenCount}
            </Badge>
            <span className="ml-auto shrink-0">
                {list.curated ? (
                    <Badge variant="outline" className="px-1.5 text-[10px]">
                        Curated
                    </Badge>
                ) : (
                    <span className="font-berkeley-mono text-[10px] text-muted-foreground">
                        {shortOwnerId(list.owner.projectId)}
                    </span>
                )}
            </span>
        </div>
    );
}

function shortOwnerId(projectId: string | undefined): string {
    if (!projectId) return '—';
    return projectId.length > 12 ? `${projectId.slice(0, 8)}…` : projectId;
}

/** Rail header action: icon-only button with a hover tooltip naming what it does. */
function RailAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label={label}
                    onClick={onClick}
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md p-0 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/10"
                >
                    {children}
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="rounded-sm bg-zinc-800 px-2 py-1 dark:bg-zinc-900">
                <p className="text-xs text-white">{label}</p>
            </TooltipContent>
        </Tooltip>
    );
}

/** Square hover affordance used by the list rail — icon-only, accessible name via aria-label. */
function IconButton({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string;
    disabled?: boolean;
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] dark:hover:bg-white/10 disabled:opacity-50"
        >
            {children}
        </button>
    );
}

/**
 * Metadata viewer modeled on the admin app's mint preview: identity header,
 * copyable mint, market field grid, and the judgment breakdown (score
 * components, reasons, warnings, attestations).
 */
function TokenMetadataSheet({
    open,
    onOpenChange,
    mint,
    fallback,
    judged,
    loading,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    mint: string | null;
    /** Identity from the row, shown while (or if) judgment data is unavailable. */
    fallback: { symbol: string | null; name: string | null; logoURI: string | null; verified?: boolean } | null;
    judged: SearchResult | null;
    loading: boolean;
}) {
    if (!mint) return null;
    const symbol = judged?.claims.symbol ?? fallback?.symbol ?? null;
    const name = judged?.claims.name ?? fallback?.name ?? null;
    const logoURI = judged?.market.logoURI ?? fallback?.logoURI ?? null;
    const verified = judged?.verified ?? fallback?.verified;

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="w-full overflow-y-auto border-border-light p-0 sm:max-w-2xl">
                <SheetHeader className="sr-only">
                    <SheetTitle>Token metadata</SheetTitle>
                    <SheetDescription>Live market data and the judgment breakdown for this mint.</SheetDescription>
                </SheetHeader>

                <div className="border-b border-border-light px-6 pb-6 pt-8 pr-14 sm:px-8 sm:pr-16">
                    <div className="flex items-start justify-between gap-4">
                        <TokenIdentity
                            mint={mint}
                            symbol={symbol}
                            name={name}
                            logoURI={logoURI}
                            {...(verified !== undefined ? { verified } : {})}
                            size="dialog"
                        >
                            {judged && judged.badges.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                    {judged.badges.map(badge => (
                                        <Badge key={badge} variant="secondary" className="px-1.5 text-[10px]">
                                            {badge}
                                        </Badge>
                                    ))}
                                </div>
                            )}
                        </TokenIdentity>
                        <CopyButton
                            textToCopy={mint}
                            showText={false}
                            ariaLabel="Copy mint address"
                            className="h-7 w-7 shrink-0 rounded-sm transition-colors duration-150 hover:bg-black/[0.06] active:scale-[0.97]"
                            iconClassName="h-3.5 w-3.5 text-muted-foreground"
                            iconClassNameCheck="h-3.5 w-3.5 text-emerald-500"
                            onCopied={() => toast.success('Mint address copied')}
                        />
                    </div>
                </div>

                <div className="space-y-10 px-6 py-8 sm:px-8">
                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <Button variant="outline" size="sm" disabled>
                                <span className="inline-flex items-center gap-2">
                                    <Spinner size="sm" />
                                    Loading metadata…
                                </span>
                            </Button>
                        </div>
                    )}

                    {!loading && !judged && (
                        <p className="py-8 text-center text-sm text-muted-foreground">
                            No live market or judgment data is available for this mint right now.
                        </p>
                    )}

                    {!loading && judged && (
                        <>
                            <section>
                                <h2 className="mb-5 text-xl font-inter-semibold text-foreground">Market</h2>
                                <div className="grid grid-cols-2 gap-px overflow-hidden bg-border-light sm:grid-cols-3">
                                    <MetadataStat label="Price" value={formatUsd(judged.market.price)} />
                                    <MetadataStat label="Liquidity" value={formatUsd(judged.market.liquidityUsd)} />
                                    <MetadataStat label="24H Volume" value={formatUsd(judged.market.volume24hUsd)} />
                                    <MetadataStat label="Market Cap" value={formatUsd(judged.market.marketCapUsd)} />
                                    <MetadataStat label="Holders" value={formatValue(judged.market.holderCount)} />
                                    <MetadataStat label="Decimals" value={formatValue(judged.market.decimals)} />
                                </div>
                            </section>

                            <section>
                                <div className="mb-5 flex items-center gap-2">
                                    <h2 className="text-xl font-inter-semibold text-foreground">Score Card</h2>
                                    <Badge
                                        variant="secondary"
                                        className="rounded-full px-2 py-0.5 font-berkeley-mono text-xs"
                                    >
                                        {judged.score.total}
                                    </Badge>
                                    <Tooltip delayDuration={300}>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                aria-label="View score reasons and evidence"
                                                className="inline-flex size-3.5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            >
                                                <IconInfoCircle aria-hidden="true" className="size-3 fill-current" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent
                                            side="right"
                                            className="max-w-64 rounded-sm bg-zinc-800 px-2 py-1.5 dark:bg-zinc-900"
                                        >
                                            <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                                Reasons
                                            </div>
                                            <div className="mt-1 flex flex-wrap gap-1">
                                                {judged.reasons.length > 0 ? (
                                                    judged.reasons.map(reason => (
                                                        <MetadataTooltipChip key={reason}>
                                                            {humanize(reason)}
                                                        </MetadataTooltipChip>
                                                    ))
                                                ) : (
                                                    <span className="text-xs text-white/70">No specific reasons.</span>
                                                )}
                                            </div>
                                            <div className="mt-2 border-t border-white/10 pt-2">
                                                <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                                    Evidence
                                                </div>
                                                <div className="mt-1 flex flex-wrap gap-1">
                                                    {judged.claims.attestations.length > 0 ? (
                                                        judged.claims.attestations.map(attestation => (
                                                            <MetadataTooltipChip
                                                                key={`${attestation.code}:${attestation.detail}`}
                                                            >
                                                                {attestation.detail}
                                                            </MetadataTooltipChip>
                                                        ))
                                                    ) : (
                                                        <span className="text-xs text-white/70">No attestations.</span>
                                                    )}
                                                </div>
                                            </div>
                                        </TooltipContent>
                                    </Tooltip>
                                    {judged.warnings.length > 0 && (
                                        <Tooltip delayDuration={300}>
                                            <TooltipTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label={`View ${judged.warnings.length} warning${judged.warnings.length === 1 ? '' : 's'}`}
                                                    className="inline-flex size-3.5 items-center justify-center rounded-full text-amber-600 transition-colors hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-300 dark:hover:text-amber-200"
                                                >
                                                    <IconExclamationmarkTriangleFill
                                                        aria-hidden="true"
                                                        className="size-3 fill-current"
                                                    />
                                                </button>
                                            </TooltipTrigger>
                                            <TooltipContent
                                                side="right"
                                                className="max-w-64 rounded-sm bg-zinc-800 px-2 py-1.5 dark:bg-zinc-900"
                                            >
                                                <div className="text-[10px] font-inter-semibold uppercase tracking-wide text-white/60">
                                                    Warnings
                                                </div>
                                                <div className="mt-1 flex flex-wrap gap-1">
                                                    {judged.warnings.map(warning => (
                                                        <MetadataTooltipChip key={warning}>
                                                            {humanize(warning)}
                                                        </MetadataTooltipChip>
                                                    ))}
                                                </div>
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                </div>
                                <div className="border-t border-border-light pt-4">
                                    <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                                        {Object.entries(judged.score.components).map(([key, value]) => (
                                            <MetadataScoreBar key={key} label={humanize(key)} value={value} />
                                        ))}
                                    </div>
                                </div>
                            </section>

                            {judged.claims.attestations.length > 0 && (
                                <section>
                                    <h2 className="mb-5 text-xl font-inter-semibold text-foreground">Evidence</h2>
                                    <div className="grid grid-cols-2 gap-px overflow-hidden bg-border-light sm:grid-cols-3">
                                        {judged.claims.attestations.map(attestation => (
                                            <MetadataStat
                                                key={`${attestation.code}:${attestation.detail}`}
                                                label={humanize(attestation.code)}
                                                value={attestation.detail}
                                            />
                                        ))}
                                    </div>
                                </section>
                            )}

                            {judged.inLists.length > 0 && (
                                <section>
                                    <h2 className="mb-3 text-sm font-inter-semibold text-foreground">
                                        Already in lists
                                    </h2>
                                    <div className="flex flex-wrap gap-1">
                                        {judged.inLists.map(slug => (
                                            <Badge key={slug} variant="outline" className="px-1.5 text-[10px]">
                                                {slug}
                                            </Badge>
                                        ))}
                                    </div>
                                </section>
                            )}
                        </>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}

export function ListsTab(): React.JSX.Element {
    const { projectId, currentApiKeyId, hasActiveApiKey, apiKeysCount } = useProjectApiKeys();
    const { setTab } = useDashboardTab();

    const playgroundFetch = useCallback(
        (path: string, init?: { method?: string; body?: unknown }) => {
            const headers: Record<string, string> = { accept: 'application/json' };
            if (projectId && currentApiKeyId) {
                headers['x-tokens-playground-project-id'] = projectId;
                headers['x-tokens-playground-api-key-id'] = currentApiKeyId;
            }
            if (init?.body !== undefined) headers['content-type'] = 'application/json';
            return fetch(path, {
                method: init?.method ?? 'GET',
                headers,
                ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
            });
        },
        [projectId, currentApiKeyId],
    );

    const [writeAccess, setWriteAccess] = useState<WriteAccess>('checking');
    const [allLists, setAllLists] = useState<V2ListSummary[] | null>(null);
    const [railTab, setRailTab] = useState<'mine' | 'community'>('mine');
    const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
    const [tokens, setTokens] = useState<V2ListToken[] | null>(null);
    const activeDetailCacheKeyRef = useRef<string | null>(null);

    const ready = Boolean(projectId && currentApiKeyId && hasActiveApiKey);

    // Scope probe: POST with an empty body mutates nothing — a key without
    // lists:write gets 403 at the scope gate; a granted key reaches body
    // validation and gets 400.
    useEffect(() => {
        if (!ready) return;
        let cancelled = false;
        setWriteAccess('checking');
        void playgroundFetch('/api/v2/lists', { method: 'POST', body: {} }).then(
            res => {
                if (!cancelled) setWriteAccess(res.status === 403 ? 'denied' : 'granted');
            },
            () => {
                if (!cancelled) setWriteAccess('denied');
            },
        );
        return () => {
            cancelled = true;
        };
    }, [ready, playgroundFetch]);

    const refreshLists = useCallback(async () => {
        if (!ready) return;
        const res = await playgroundFetch('/api/v2/lists?limit=500');
        if (!res.ok) return;
        const body = (await res.json()) as { lists: V2ListSummary[] };
        setAllLists(body.lists);
    }, [ready, playgroundFetch]);

    useEffect(() => {
        setAllLists(null);
        setSelectedSlug(null);
        void refreshLists();
    }, [refreshLists]);

    const myLists = useMemo(
        () => (allLists ? allLists.filter(list => !list.curated && list.owner.projectId === projectId) : null),
        [allLists, projectId],
    );
    // Everything browsable that isn't mine: curated lists lead (API order), then
    // other projects' published lists.
    const communityLists = useMemo(
        () => (allLists ? allLists.filter(list => list.curated || list.owner.projectId !== projectId) : null),
        [allLists, projectId],
    );

    const selectedList = useMemo(
        () => allLists?.find(list => list.slug === selectedSlug) ?? null,
        [allLists, selectedSlug],
    );
    const selectedIsOwned = useMemo(
        () => Boolean(selectedList && !selectedList.curated && selectedList.owner.projectId === projectId),
        [selectedList, projectId],
    );
    const railTabs = useMemo(
        () =>
            [
                { id: 'mine', label: 'My lists' },
                {
                    id: 'community',
                    label: communityLists ? `Community (${communityLists.length})` : 'Community',
                },
            ] as const satisfies ReadonlyArray<{ id: 'mine' | 'community'; label: string }>,
        [communityLists],
    );

    const composableLists = useMemo<ComposableList[]>(
        () =>
            (allLists ?? []).map(list => ({
                slug: list.slug,
                name: list.name,
                curated: list.curated,
                ownedByMe: !list.curated && list.owner.projectId === projectId,
                tokenCount: list.tokenCount,
            })),
        [allLists, projectId],
    );

    const detailCacheKey = projectId && selectedSlug ? `${projectId}:${selectedSlug}` : null;

    const refreshDetail = useCallback(async () => {
        if (!selectedSlug || !detailCacheKey) {
            setTokens(null);
            return;
        }
        const res = await playgroundFetch(`/api/v2/lists/${selectedSlug}?limit=2000`);
        if (!res.ok) {
            // Never replace a usable stale entry with a transient failure.
            if (!listTokenCache.has(detailCacheKey) && activeDetailCacheKeyRef.current === detailCacheKey) {
                setTokens([]);
            }
            return;
        }
        const body = (await res.json()) as { tokens: V2ListToken[] };
        const nextTokens = body.tokens;
        writeCacheEntry(listTokenCache, detailCacheKey, { tokens: nextTokens, cachedAt: Date.now() });
        // A slower response for a list we already left may populate its cache,
        // but must never replace the currently visible list.
        if (activeDetailCacheKeyRef.current === detailCacheKey) setTokens(nextTokens);
    }, [selectedSlug, detailCacheKey, playgroundFetch]);

    useEffect(() => {
        activeDetailCacheKeyRef.current = detailCacheKey;
        if (!detailCacheKey) {
            setTokens(null);
            return;
        }

        const cached = readCacheEntry(listTokenCache, detailCacheKey);
        if (cached) {
            // Stale-while-revalidate keeps the table and images visible even
            // when the entry is old enough to refresh in the background.
            setTokens(cached.tokens);
            if (Date.now() - cached.cachedAt >= LIST_TOKEN_CACHE_TTL_MS) void refreshDetail();
            return;
        }

        setTokens(null);
        void refreshDetail();
    }, [detailCacheKey, refreshDetail]);

    // ---- create dialog ----
    const [createOpen, setCreateOpen] = useState(false);
    const [composeOpen, setComposeOpen] = useState(false);
    const [createSlug, setCreateSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [createName, setCreateName] = useState('');
    const [createError, setCreateError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const createSlugAvailability = useSlugAvailability(createSlug, {
        enabled: createOpen,
        fetcher: playgroundFetch,
    });
    const createSlugMessage = slugAvailabilityMessage(createSlugAvailability);
    const createSlugBlocked = createSlugAvailability.state === 'unavailable';

    const handleCreate = useCallback(async () => {
        setCreateError(null);
        setCreating(true);
        try {
            const res = await playgroundFetch('/api/v2/lists', {
                method: 'POST',
                body: { slug: createSlug.trim(), name: createName.trim() },
            });
            const body = (await res.json()) as { list?: { slug: string }; error?: { message?: string } };
            if (!res.ok) throw new Error(body.error?.message ?? `Create failed (HTTP ${res.status})`);
            setCreateOpen(false);
            setCreateSlug('');
            setCreateName('');
            setSlugTouched(false);
            toast.success(`List "${createName.trim()}" created`);
            await refreshLists();
            if (body.list) setSelectedSlug(body.list.slug);
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : String(error));
        } finally {
            setCreating(false);
        }
    }, [playgroundFetch, createSlug, createName, refreshLists]);

    // ---- row actions: quick delete (two-step confirm) + settings dialog ----
    const [deleteSlug, setDeleteSlug] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [settingsSlug, setSettingsSlug] = useState<string | null>(null);

    /** DELETE is a hard delete: the list is gone and its slug is claimable again. */
    const handleDelete = useCallback(
        async (slug: string) => {
            setDeleting(true);
            try {
                const res = await playgroundFetch(`/api/v2/lists/${slug}`, { method: 'DELETE' });
                if (!res.ok) {
                    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                    throw new Error(body?.error?.message ?? `Delete failed (HTTP ${res.status})`);
                }
                toast.success(`List "${slug}" deleted`);
                if (projectId) listTokenCache.delete(`${projectId}:${slug}`);
                setSelectedSlug(current => (current === slug ? null : current));
                await refreshLists();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error));
            } finally {
                setDeleting(false);
                setDeleteSlug(null);
            }
        },
        [projectId, playgroundFetch, refreshLists],
    );

    /** A slug change here renames the list; the previous path stops resolving. */
    const handleUpdateList = useCallback(
        async (slug: string, patch: { slug: string; name: string }) => {
            const res = await playgroundFetch(`/api/v2/lists/${slug}`, { method: 'PATCH', body: patch });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                throw new Error(body?.error?.message ?? `Update failed (HTTP ${res.status})`);
            }
            await refreshLists();
            // Keep the rail/detail pointed at the list after a rename.
            if (patch.slug !== slug) {
                if (projectId) {
                    const oldKey = `${projectId}:${slug}`;
                    const cached = listTokenCache.get(oldKey);
                    listTokenCache.delete(oldKey);
                    if (cached) writeCacheEntry(listTokenCache, `${projectId}:${patch.slug}`, cached);
                }
                setSelectedSlug(current => (current === slug ? patch.slug : current));
                setSettingsSlug(current => (current === slug ? patch.slug : current));
            }
        },
        [projectId, playgroundFetch, refreshLists],
    );

    // ---- curator search (⌘K palette) ----
    const [searchOpen, setSearchOpen] = useState(false);
    const [addingMint, setAddingMint] = useState<string | null>(null);

    const memberMints = useMemo(() => new Set((tokens ?? []).map(t => t.mint)), [tokens]);

    // ⌘K / Ctrl+K opens the palette whenever an OWNED list is selected.
    useEffect(() => {
        if (!selectedSlug || !selectedIsOwned) return;
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setSearchOpen(previous => !previous);
            }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedSlug, selectedIsOwned]);

    const handleAddMint = useCallback(
        async (result: SearchResult) => {
            if (!selectedSlug) return;
            setAddingMint(result.mint);
            try {
                const res = await playgroundFetch(`/api/v2/lists/${selectedSlug}/members/${result.mint}`, {
                    method: 'PUT',
                });
                if (!res.ok) {
                    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                    throw new Error(body?.error?.message ?? `Add failed (HTTP ${res.status})`);
                }
                toast.success(`${result.claims.symbol ?? shortMint(result.mint)} added to ${selectedSlug}`);
                await Promise.all([refreshDetail(), refreshLists()]);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error));
            } finally {
                setAddingMint(null);
            }
        },
        [selectedSlug, playgroundFetch, refreshDetail, refreshLists],
    );

    // ---- multi-select + bulk removal (svela-style selection dock) ----
    const removeSelectedMints = useCallback(
        async (mints: string[]) => {
            if (!selectedSlug) return;
            // Per-mint fan-out (no bulk endpoint; member counts are small). A
            // partial failure reports exact counts via BulkRemoveError.
            const results = await Promise.allSettled(
                mints.map(async mint => {
                    const res = await playgroundFetch(`/api/v2/lists/${selectedSlug}/members/${mint}`, {
                        method: 'DELETE',
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                }),
            );
            const failedCount = results.filter(result => result.status === 'rejected').length;
            await Promise.all([refreshDetail(), refreshLists()]);
            if (failedCount > 0) {
                throw new BulkRemoveError({ removedCount: mints.length - failedCount, failedCount });
            }
        },
        [selectedSlug, playgroundFetch, refreshDetail, refreshLists],
    );
    const memberSelection = useListSelection({ removeSelected: removeSelectedMints });
    const clearMemberSelection = memberSelection.clear;

    // Selection belongs to one list — switching lists drops it.
    useEffect(() => {
        clearMemberSelection();
    }, [selectedSlug, clearMemberSelection]);

    // ---- metadata sheet ----
    const [metadataOpen, setMetadataOpen] = useState(false);
    const [metadataMint, setMetadataMint] = useState<string | null>(null);
    const [metadataFallback, setMetadataFallback] = useState<{
        symbol: string | null;
        name: string | null;
        logoURI: string | null;
        verified?: boolean;
    } | null>(null);
    const [metadataJudged, setMetadataJudged] = useState<SearchResult | null>(null);
    const [metadataLoading, setMetadataLoading] = useState(false);
    const activeMetadataCacheKeyRef = useRef<string | null>(null);

    /** Member rows fetch the judged result on open (mint query, degen so gates never hide it). */
    const openMetadataForMember = useCallback(
        (token: V2ListToken) => {
            setMetadataMint(token.mint);
            setMetadataFallback({
                symbol: token.symbol,
                name: token.name,
                logoURI: token.logoURI,
                verified: token.verified,
            });
            setMetadataOpen(true);

            const metadataCacheKey = `${projectId ?? 'unknown'}:${token.mint}`;
            activeMetadataCacheKeyRef.current = metadataCacheKey;
            const cached = readCacheEntry(tokenMetadataCache, metadataCacheKey);
            if (cached && Date.now() - cached.cachedAt < TOKEN_METADATA_CACHE_TTL_MS) {
                setMetadataJudged(cached.result);
                setMetadataLoading(false);
                return;
            }

            setMetadataJudged(null);
            setMetadataLoading(true);
            void playgroundFetch(`/api/v2/lists/search-tokens?q=${encodeURIComponent(token.mint)}&policy=degen&limit=1`)
                .then(async res => {
                    if (!res.ok) return;
                    const body = (await res.json()) as { results: SearchResult[] };
                    const match = body.results.find(result => result.mint === token.mint) ?? null;
                    writeCacheEntry(tokenMetadataCache, metadataCacheKey, { result: match, cachedAt: Date.now() });
                    if (activeMetadataCacheKeyRef.current === metadataCacheKey) setMetadataJudged(match);

                    // If live metadata supplied an image the list response did
                    // not have, update both the visible row and its list cache.
                    const logoURI = match?.market.logoURI;
                    if (logoURI && detailCacheKey) {
                        setTokens(current => {
                            if (!current) return current;
                            const next = current.map(row =>
                                row.mint === token.mint && !row.logoURI ? { ...row, logoURI } : row,
                            );
                            writeCacheEntry(listTokenCache, detailCacheKey, { tokens: next, cachedAt: Date.now() });
                            return next;
                        });
                    }
                })
                .catch(() => {})
                .finally(() => {
                    if (activeMetadataCacheKeyRef.current === metadataCacheKey) setMetadataLoading(false);
                });
        },
        [projectId, detailCacheKey, playgroundFetch],
    );

    const settingsList = useMemo(
        () => myLists?.find(list => list.slug === settingsSlug) ?? null,
        [myLists, settingsSlug],
    );

    if (apiKeysCount === 0) {
        return (
            <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-foreground">Token Lists</h1>
                    <p className="text-muted-foreground">
                        Curate lists of tokens for your community — any app can consume them via the v2 API.
                    </p>
                </div>
                <div className="relative z-10 rounded-2xl border border-dashed border-black/20 bg-background/80 py-12 backdrop-blur-sm">
                    <EmptyState
                        icon={<IconKeySlashFill className="size-[60px] mb-2 fill-muted-foreground" />}
                        title="No API keys found"
                        subtitle="Create an API key to start managing token lists."
                        className="p-12 w-full sm:w-[420px] mx-auto"
                    />
                    <div className="flex justify-center">
                        <Button variant="outline" size="sm" onClick={() => setTab('api-manager')}>
                            Create API key
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    if (!ready || writeAccess === 'checking') {
        return (
            <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                <div className="mb-6 space-y-2">
                    <Skeleton className="h-9 w-48" />
                    <Skeleton className="h-4 w-[520px] max-w-full" />
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8">
                    <Skeleton className="h-[280px] w-full rounded-[12px]" />
                    <Skeleton className="h-[420px] w-full rounded-[12px]" />
                </div>
            </div>
        );
    }

    if (writeAccess === 'denied') {
        return (
            <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-foreground">Token Lists</h1>
                    <p className="text-muted-foreground">
                        Publish curated token lists any app can consume via the v2 API.
                    </p>
                </div>
                <div className="relative z-10 bg-background/80 backdrop-blur-sm rounded-2xl border border-dashed border-black/20 py-12">
                    <EmptyState
                        icon={<IconCircleGridCrossFill className="size-[60px] mb-2 fill-muted-foreground" />}
                        title="List publishing is invite-only"
                        subtitle="Your project's API key doesn't have the lists:write scope yet. Reach out to the Tokens team to request access for your community."
                        className="p-12 w-full sm:w-[480px] mx-auto"
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        className="flex justify-center"
                    >
                        <Button asChild variant="ghost" size="sm" className="rounded-lg">
                            <a href="https://docs.tokens.xyz" target="_blank" rel="noreferrer">
                                Read the lists documentation
                            </a>
                        </Button>
                    </motion.div>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6 container max-w-7xl mx-auto py-16 px-6">
            <div className="mb-6">
                <h1 className="text-3xl font-bold text-foreground">Token Lists</h1>
                <p className="text-muted-foreground">
                    Curate lists of tokens for your community — any app can consume them via the v2 API.
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8 items-start">
                {/* Rail — mine/community tabs left, create + compose actions opposite */}
                <div className="space-y-4">
                    <div className="flex items-end justify-between gap-2 border-b border-border">
                        <TabNavigation
                            tabs={railTabs}
                            activeIndex={railTab === 'mine' ? 0 : 1}
                            onTabClick={id => setRailTab(id)}
                            // Zeroing the DS padding var keeps the active-tab underline
                            // aligned with the label: the indicator insets itself by the
                            // same var the tab pads with.
                            containerClassName="flex justify-start px-0 [--tab-padding-x-md:0px]"
                            listClassName="w-max gap-4"
                        />
                        <div className="flex items-center gap-2 pb-1.5">
                            <RailAction label="Compose an endpoint" onClick={() => setComposeOpen(true)}>
                                <StackIcon className="size-6 text-muted-foreground" />
                            </RailAction>
                            <RailAction label="New list" onClick={() => setCreateOpen(true)}>
                                <PlusIcon className="size-6 text-muted-foreground" />
                            </RailAction>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        {allLists === null ? (
                            Array.from({ length: 3 }).map((_, index) => (
                                <div
                                    key={index}
                                    className="rounded-lg border border-black/[0.12] bg-white px-3 py-2.5 shadow-sm dark:border-white/10 dark:bg-zinc-950/30"
                                >
                                    <Skeleton className="h-4 w-32" />
                                </div>
                            ))
                        ) : railTab === 'mine' ? (
                            !myLists || myLists.length === 0 ? (
                                <div className="rounded-lg border border-dashed border-black/20 px-4 py-6 text-center text-sm text-muted-foreground">
                                    No lists yet — create one to get started.
                                </div>
                            ) : (
                                myLists.map(list => (
                                    <ListRailRow
                                        key={list.slug}
                                        list={list}
                                        selected={list.slug === selectedSlug}
                                        onSelect={() => setSelectedSlug(list.slug)}
                                        onEdit={() => {
                                            setDeleteSlug(null);
                                            setSettingsSlug(list.slug);
                                        }}
                                        confirmingDelete={deleteSlug === list.slug}
                                        deleting={deleting}
                                        onDeleteArm={() => setDeleteSlug(list.slug)}
                                        onDeleteCancel={() => setDeleteSlug(null)}
                                        onDeleteConfirm={() => void handleDelete(list.slug)}
                                    />
                                ))
                            )
                        ) : !communityLists || communityLists.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-black/20 px-4 py-6 text-center text-sm text-muted-foreground">
                                No community lists published yet.
                            </div>
                        ) : (
                            communityLists.map(list => (
                                <CommunityRailRow
                                    key={list.slug}
                                    list={list}
                                    selected={list.slug === selectedSlug}
                                    onSelect={() => setSelectedSlug(list.slug)}
                                />
                            ))
                        )}
                    </div>
                </div>

                {/* Selected list */}
                <div className="space-y-8">
                    {!selectedList ? (
                        <div className="bg-background/80 backdrop-blur-sm rounded-2xl border border-dashed border-black/20 py-12">
                            <EmptyState
                                icon={<IconCircleGridCrossFill className="size-[48px] mb-2 fill-muted-foreground" />}
                                title={myLists && myLists.length > 0 ? 'Select a list' : 'Create your first list'}
                                subtitle={
                                    myLists && myLists.length > 0
                                        ? 'Pick a list on the left to manage its tokens.'
                                        : 'Lists are served publicly at /api/v2/lists/{slug}.'
                                }
                                className="p-8 w-full sm:w-[420px] mx-auto"
                            />
                        </div>
                    ) : (
                        <>
                            {/* Members — list title + copyable endpoint left, ⌘K search trigger opposite */}
                            <div className="space-y-4">
                                <div className="flex items-end justify-between gap-4">
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-1.5">
                                            <h2 className="text-xl font-inter-semibold">{selectedList.name}</h2>
                                            {selectedList.curated ? (
                                                <Badge variant="outline" className="px-1.5 text-[10px]">
                                                    Curated
                                                </Badge>
                                            ) : !selectedIsOwned ? (
                                                <Badge
                                                    variant="secondary"
                                                    className="px-1.5 font-berkeley-mono text-[10px]"
                                                >
                                                    {shortOwnerId(selectedList.owner.projectId)}
                                                </Badge>
                                            ) : null}
                                            <Tooltip delayDuration={300}>
                                                <TooltipTrigger asChild>
                                                    <button
                                                        type="button"
                                                        aria-label="About this table"
                                                        className="flex size-5 items-center justify-center rounded-md transition-colors hover:bg-black/[0.06] dark:hover:bg-white/10"
                                                    >
                                                        <IconInfoCircle className="size-3.5 fill-muted-foreground" />
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                    side="top"
                                                    className="max-w-[260px] rounded-sm bg-zinc-800 px-2 py-1 dark:bg-zinc-900"
                                                >
                                                    <p className="text-xs text-white">
                                                        What consumers of this list receive, in rank order — click a row
                                                        for metadata.
                                                    </p>
                                                </TooltipContent>
                                            </Tooltip>
                                        </div>
                                        <CopyButton
                                            textToCopy={`https://api.tokens.xyz/api/v2/lists/${selectedList.slug}`}
                                            ariaLabel="Copy list endpoint URL"
                                            displayText={`/v2/lists/${selectedList.slug}`}
                                            // CopyButton hardcodes text-sm on its label; the child
                                            // selector trims it for this inline chip.
                                            className="rounded-md bg-gray-100 px-2 py-1 dark:bg-zinc-900 [&>span]:text-xs"
                                            iconClassName="h-3 w-3 text-muted-foreground"
                                            iconClassNameCheck="h-3 w-3"
                                            onCopied={() => toast.success('Endpoint URL copied')}
                                        />
                                    </div>
                                    {selectedIsOwned && (
                                        <button
                                            type="button"
                                            onClick={() => setSearchOpen(true)}
                                            className="group flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-border-medium bg-white px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:border-black/25 hover:text-foreground active:scale-[0.99] dark:bg-zinc-950/30"
                                        >
                                            <IconMagnifyingglass className="size-3 fill-muted-foreground transition-colors group-hover:fill-foreground" />
                                            <span>Add tokens</span>
                                            <span className="flex items-center gap-0.5">
                                                <kbd className="rounded-sm bg-gray-100 p-1 dark:bg-zinc-800">
                                                    <IconCommand className="size-2 fill-muted-foreground" />
                                                </kbd>
                                                <kbd className="rounded-sm bg-gray-100 p-1 dark:bg-zinc-800">
                                                    <IconK className="size-2 fill-muted-foreground" />
                                                </kbd>
                                            </span>
                                        </button>
                                    )}
                                </div>
                                {tokens === null ? (
                                    <div className="rounded-[12px] bg-gray-100/60 p-0.5">
                                        <div className="bg-white dark:bg-zinc-950/30 border border-black/[0.15] rounded-lg shadow-sm overflow-hidden">
                                            {Array.from({ length: 3 }).map((_, index) => (
                                                <div
                                                    key={index}
                                                    className="grid gap-4 px-4 py-2 border-b last:border-b-0"
                                                    style={{ gridTemplateColumns: MEMBER_GRID_TEMPLATE_COLUMNS }}
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <Skeleton className="h-5 w-5 rounded-full" />
                                                        <Skeleton className="h-4 w-40" />
                                                    </div>
                                                    <div className="flex items-center">
                                                        <Skeleton className="h-4 w-24" />
                                                    </div>
                                                    <div className="flex items-center">
                                                        <Skeleton className="h-4 w-16" />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : tokens.length === 0 ? (
                                    <div className="bg-background/80 rounded-2xl border border-dashed border-black/20 px-6 py-8 text-center text-sm text-muted-foreground">
                                        {selectedIsOwned
                                            ? 'Empty list — press ⌘K (or use the search above) to add the first token.'
                                            : 'This list has no tokens yet.'}
                                    </div>
                                ) : (
                                    <MemberTable
                                        tokens={tokens}
                                        {...(selectedIsOwned ? { selection: memberSelection } : {})}
                                        onRowClick={openMetadataForMember}
                                    />
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {selectedIsOwned && (
                <SelectionDock
                    selection={memberSelection}
                    totalCount={tokens?.length ?? 0}
                    allMints={tokens?.map(token => token.mint) ?? []}
                />
            )}

            {selectedSlug && selectedIsOwned && (
                <TokenSearchCommand
                    open={searchOpen}
                    onOpenChange={setSearchOpen}
                    listSlug={selectedSlug}
                    memberMints={memberMints}
                    playgroundFetch={playgroundFetch}
                    addingMint={addingMint}
                    onAdd={result => void handleAddMint(result)}
                />
            )}

            <ComposeEndpointSheet
                open={composeOpen}
                onOpenChange={setComposeOpen}
                lists={composableLists}
                playgroundFetch={playgroundFetch}
            />

            <TokenMetadataSheet
                open={metadataOpen}
                onOpenChange={setMetadataOpen}
                mint={metadataMint}
                fallback={metadataFallback}
                judged={metadataJudged}
                loading={metadataLoading}
            />

            <ListSettingsDialog
                list={settingsList}
                isOpen={settingsList !== null}
                onClose={() => setSettingsSlug(null)}
                fetcher={playgroundFetch}
                onSave={patch => handleUpdateList(settingsList?.slug ?? '', patch)}
                onDelete={() => handleDelete(settingsList?.slug ?? '')}
            />

            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">Create a list</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="list-name" className="text-[11px] uppercase text-text-extra-low">
                                Name
                            </Label>
                            <Input
                                id="list-name"
                                value={createName}
                                onChange={event => {
                                    setCreateName(event.target.value);
                                    if (!slugTouched) setCreateSlug(slugify(event.target.value));
                                }}
                                placeholder="Ownership Core"
                                className="mt-1 rounded-lg bg-zinc-50 transition-all duration-150 ease-out focus-visible:border-zinc-400/60 focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-zinc-400/20 focus-visible:ring-offset-0 dark:bg-zinc-900 dark:focus-visible:border-zinc-600/80 dark:focus-visible:bg-zinc-950/50 dark:focus-visible:ring-zinc-600/20"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="list-slug" className="text-[11px] uppercase text-text-extra-low">
                                Slug
                            </Label>
                            <Input
                                id="list-slug"
                                value={createSlug}
                                onChange={event => {
                                    setSlugTouched(true);
                                    setCreateSlug(event.target.value);
                                }}
                                placeholder="ownership-core"
                                aria-invalid={createSlugBlocked}
                                className={`mt-1 rounded-lg bg-zinc-50 font-berkeley-mono transition-all duration-150 ease-out focus-visible:border-zinc-400/60 focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-zinc-400/20 focus-visible:ring-offset-0 dark:bg-zinc-900 dark:focus-visible:border-zinc-600/80 dark:focus-visible:bg-zinc-950/50 dark:focus-visible:ring-zinc-600/20 ${
                                    createSlugBlocked
                                        ? 'border-destructive text-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                                        : ''
                                }`}
                            />
                            {createSlugMessage ? (
                                <p
                                    className={`text-xs ${
                                        createSlugBlocked ? 'text-destructive' : 'text-muted-foreground'
                                    }`}
                                >
                                    {createSlugMessage}
                                </p>
                            ) : (
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    {createSlugAvailability.state === 'checking' && <Spinner size="sm" />}
                                    {createSlugAvailability.state === 'available' && (
                                        <IconCheckmark className="size-3 fill-emerald-600" />
                                    )}
                                    Becomes the public read path{' '}
                                    <code className="font-berkeley-mono">
                                        /api/v2/lists/{createSlug.trim() || '{slug}'}
                                    </code>
                                    {createSlugAvailability.state === 'available' && ' — available'}
                                </div>
                            )}
                        </div>
                        {createError && (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
                                {createError}
                            </div>
                        )}
                    </div>
                    <DialogFooter className="flex !flex-col gap-2">
                        <Button
                            variant="default"
                            onClick={() => void handleCreate()}
                            disabled={
                                creating ||
                                !createSlug.trim() ||
                                !createName.trim() ||
                                createSlugBlocked ||
                                createSlugAvailability.state === 'checking'
                            }
                            className="w-full"
                        >
                            {creating ? <Spinner size="sm" /> : 'Create list'}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => setCreateOpen(false)}
                            disabled={creating}
                            className="w-full"
                        >
                            Cancel
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
