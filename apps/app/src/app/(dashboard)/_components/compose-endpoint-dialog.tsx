'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@tokens/ui/badge';
import { Button } from '@tokens/ui/button';
import { Checkbox } from '@tokens/ui/checkbox';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@tokens/ui/sheet';
import { Spinner } from '@tokens/ui/spinner';
import { CopyButton } from '@/components/app-ui/copy-button';

import { SectionHeading, type PlaygroundFetcher } from './token-bits';

/** The compose API unions at most this many lists per call. */
const MAX_COMPOSED_LISTS = 10;

const PUBLIC_API_ORIGIN = 'https://api.tokens.xyz';

export interface ComposableList {
    slug: string;
    name: string;
    curated: boolean;
    ownedByMe: boolean;
    tokenCount: number;
}

/**
 * Endpoint builder over GET /v2/lists/tokens: check up to ten lists — yours,
 * curated, anyone's — and walk away with the composed URL. Nothing is
 * persisted; the URL is the product.
 */
export function ComposeEndpointSheet({
    open,
    onOpenChange,
    lists,
    playgroundFetch,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    lists: ComposableList[];
    playgroundFetch: PlaygroundFetcher;
}) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [unionTotal, setUnionTotal] = useState<number | null>(null);
    const [previewing, setPreviewing] = useState(false);

    useEffect(() => {
        if (!open) {
            setSelected(new Set());
            setUnionTotal(null);
        }
    }, [open]);

    const selectedLists = useMemo(
        // Catalog order keeps the query readable (curated first).
        () => lists.filter(list => selected.has(list.slug)),
        [lists, selected],
    );
    const slugs = useMemo(() => selectedLists.map(list => list.slug), [selectedLists]);
    const atCap = slugs.length >= MAX_COMPOSED_LISTS;

    const composePath = slugs.length > 0 ? `/api/v2/lists/tokens?lists=${slugs.join(',')}` : null;
    const composeUrl = composePath ? `${PUBLIC_API_ORIGIN}${composePath}` : null;

    // Live union size: the compose response's `total` is the deduped union
    // across the checked lists. Best-effort — the URL works regardless.
    useEffect(() => {
        if (!open || slugs.length === 0) {
            setUnionTotal(null);
            return;
        }
        let cancelled = false;
        setPreviewing(true);
        const handle = setTimeout(() => {
            void playgroundFetch(`/api/v2/lists/tokens?lists=${encodeURIComponent(slugs.join(','))}&limit=1`)
                .then(async res => {
                    if (!res.ok) return;
                    const body = (await res.json()) as { total?: number };
                    if (!cancelled && typeof body.total === 'number') setUnionTotal(body.total);
                })
                .catch(() => {})
                .finally(() => {
                    if (!cancelled) setPreviewing(false);
                });
        }, 300);
        return () => {
            cancelled = true;
            clearTimeout(handle);
            setPreviewing(false);
        };
    }, [open, slugs, playgroundFetch]);

    const toggle = (slug: string, checked: boolean) => {
        setSelected(previous => {
            const next = new Set(previous);
            if (checked) next.add(slug);
            else next.delete(slug);
            return next;
        });
    };

    const groups: Array<{ heading: string; items: ComposableList[] }> = [
        { heading: 'My lists', items: lists.filter(list => list.ownedByMe) },
        { heading: 'Curated', items: lists.filter(list => list.curated) },
        { heading: 'Community', items: lists.filter(list => !list.ownedByMe && !list.curated) },
    ];

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent className="w-full overflow-y-auto border-border-light sm:max-w-lg">
                <SheetHeader>
                    <SheetTitle>Compose an endpoint</SheetTitle>
                    <SheetDescription>
                        Pick up to {MAX_COMPOSED_LISTS} lists — the composed URL returns their union, deduped by mint,
                        with each token tagged by the lists that contain it.
                    </SheetDescription>
                </SheetHeader>

                <div className="space-y-4 py-2">
                    {groups.map(group =>
                        group.items.length === 0 ? null : (
                            <div key={group.heading} className="space-y-1.5">
                                <SectionHeading>{group.heading}</SectionHeading>
                                {group.items.map(list => {
                                    const checked = selected.has(list.slug);
                                    return (
                                        <label
                                            key={list.slug}
                                            className={`flex cursor-pointer items-center gap-3 rounded-lg border border-black/[0.12] bg-white px-3 py-2 shadow-sm transition-colors hover:bg-gray-50/60 dark:border-white/10 dark:bg-zinc-950/30 dark:hover:bg-zinc-900/40 ${
                                                !checked && atCap ? 'cursor-not-allowed opacity-50' : ''
                                            }`}
                                        >
                                            <Checkbox
                                                checked={checked}
                                                disabled={!checked && atCap}
                                                onCheckedChange={value => toggle(list.slug, value === true)}
                                                aria-label={`Include ${list.name}`}
                                            />
                                            <span className="min-w-0 flex-1 truncate text-sm font-inter-medium">
                                                {list.name}
                                            </span>
                                            <code className="shrink-0 font-berkeley-mono text-xs text-muted-foreground">
                                                {list.slug}
                                            </code>
                                            <Badge
                                                variant="secondary"
                                                className="shrink-0 px-1.5 font-berkeley-mono text-[10px]"
                                            >
                                                {list.tokenCount}
                                            </Badge>
                                        </label>
                                    );
                                })}
                            </div>
                        ),
                    )}

                    {atCap && (
                        <p className="text-xs text-muted-foreground">
                            {MAX_COMPOSED_LISTS} lists max — the compose API caps each call.
                        </p>
                    )}

                    {/* The product: a live, copyable endpoint. */}
                    <div className="space-y-2">
                        <SectionHeading>Your endpoint</SectionHeading>
                        <div className="overflow-hidden rounded-lg border border-white/10 bg-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.12)]">
                            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
                                <span className="font-berkeley-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                                    Request preview
                                </span>
                                {composeUrl && (
                                    <CopyButton
                                        textToCopy={composeUrl}
                                        showText={false}
                                        ariaLabel="Copy composed endpoint URL"
                                        className="h-7 w-7 shrink-0 rounded-sm transition-colors duration-150 hover:bg-white/10 active:scale-[0.97]"
                                        iconClassName="h-3.5 w-3.5 text-zinc-400"
                                        iconClassNameCheck="h-3.5 w-3.5 text-emerald-400"
                                        onCopied={() => toast.success('Endpoint URL copied')}
                                    />
                                )}
                            </div>

                            <div className="px-3 py-3">
                                <code className="block break-all font-berkeley-mono text-xs leading-5">
                                    <span className="font-semibold text-emerald-400">GET</span>{' '}
                                    <span className="text-zinc-400">{PUBLIC_API_ORIGIN}</span>
                                    <span className="text-sky-400">/api/v2/lists/tokens</span>
                                    <span className="text-fuchsia-300">?lists</span>
                                    <span className="text-zinc-500">=</span>
                                    {selectedLists.length > 0 ? (
                                        selectedLists.map((list, index) => (
                                            <span key={list.slug}>
                                                {index > 0 && <span className="text-zinc-500">,</span>}
                                                <span className="text-amber-300">{list.slug}</span>
                                            </span>
                                        ))
                                    ) : (
                                        <span className="italic text-zinc-600">select-a-list</span>
                                    )}
                                </code>

                                {selectedLists.length > 0 ? (
                                    <div className="mt-3 border-t border-white/10 pt-3">
                                        <p className="font-berkeley-mono text-[10px] uppercase tracking-[0.12em] text-zinc-600">
                                            Selected lists
                                        </p>
                                        <div className="mt-2 space-y-1.5">
                                            {selectedLists.map(list => (
                                                <div
                                                    key={list.slug}
                                                    className="flex min-w-0 items-baseline justify-between gap-3 font-berkeley-mono text-xs"
                                                >
                                                    <span className="truncate text-zinc-200">{list.name}</span>
                                                    <span className="shrink-0 text-amber-300">{list.slug}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <p className="mt-3 border-t border-white/10 pt-3 text-xs text-zinc-500">
                                        Select a list above to build the request.
                                    </p>
                                )}

                                <div className="mt-3 flex min-h-4 items-center gap-1.5 text-xs text-zinc-500">
                                    {previewing ? (
                                        <>
                                            <Spinner size="sm" /> Sizing the union…
                                        </>
                                    ) : unionTotal !== null ? (
                                        <>
                                            {unionTotal.toLocaleString()} token{unionTotal === 1 ? '' : 's'} across{' '}
                                            {slugs.length} list{slugs.length === 1 ? '' : 's'} (deduped)
                                        </>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <SheetFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Done
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
}
