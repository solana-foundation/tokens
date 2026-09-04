'use client';

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Effect } from 'effect';
import { BarChart3, Clock, Search } from 'lucide-react';
import { trackEvent } from '@/lib/posthog-client';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@tokens/ui/command';
import { Skeleton } from '@tokens/ui/skeleton';
import { useLocalStorage, useMediaQuery } from '@tokens/ui/hooks';
import { fetchCuratedTokens, useCuratedTokens, useSearchTokens } from '@/hooks/queries/use-token-search';
import { cleanTokenName } from '@/lib/logo-overrides';
import { formatLargeNumber, formatPrice } from '@/lib/format';
import { CURATED_LIST_ORDER_WITHOUT_LSTS } from '@/lib/curated-lists';
import type { CuratedListSlug } from '@tokens/asset-registry/curated-lists';
import { getVariantByMint } from '@tokens/asset-registry';
import type { Token } from '@/lib/types';
import { apiJson } from '@/effect/api-client';

interface RecentSolanaTokenEntry {
    token: Token;
    selectedAt: number;
}

interface CuratedMintResponse {
    assets: Array<{
        primaryVariant: {
            mint: string;
        } | null;
    }>;
}

const TOKEN_SEARCH_LIST_ORDER = CURATED_LIST_ORDER_WITHOUT_LSTS;
const TOP_TOKENS_LIST_ID: CuratedListSlug = 'majors';

function tokenMatchesQuery(token: Token, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;

    const cleanedName = cleanTokenName(token.name).toLowerCase();

    return (
        (token.assetId ?? '').toLowerCase().includes(q) ||
        (token.coingeckoId ?? '').toLowerCase().includes(q) ||
        token.symbol.toLowerCase().includes(q) ||
        token.name.toLowerCase().includes(q) ||
        cleanedName.includes(q) ||
        token.address.toLowerCase().includes(q)
    );
}

function tokenCommandValue(token: Token): string {
    const tokenDisplayName = cleanTokenName(token.name);
    return [token.symbol, token.name, tokenDisplayName, token.address, token.assetId, token.coingeckoId]
        .filter((value): value is string => Boolean(value?.trim()))
        .join(' ');
}

function TokenLogo({ token }: { token: Token }) {
    const [hasError, setHasError] = React.useState(false);

    if (!token.logoURI || hasError) {
        return (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-text-medium">
                {(token.symbol || token.name || '??').slice(0, 2).toUpperCase()}
            </div>
        );
    }

    return (
        <Image
            src={token.logoURI}
            alt={token.symbol}
            className="h-8 w-8 rounded-full bg-gray-50 object-cover"
            width={32}
            height={32}
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
        />
    );
}

function CommandGroupHeading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <span className="flex items-center gap-1.5">
            <span className="shrink-0">{icon}</span>
            <span>{children}</span>
        </span>
    );
}

function Keycap({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-4 select-none items-center justify-center rounded border border-border-light bg-gray-50 px-2 font-sans text-[11px] font-medium text-text-medium">
            {children}
        </kbd>
    );
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
                {keys.map(key => (
                    <Keycap key={key}>{key}</Keycap>
                ))}
            </div>
            <span className="text-xs text-text-high">{label}</span>
        </div>
    );
}

function TokenSearchItemSkeleton({ index }: { index: number }) {
    return (
        <CommandItem disabled value={`__loading__${index}`} className="flex items-center gap-3 px-3 py-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-10 rounded" />
                    <Skeleton className="h-4 w-40 rounded" />
                </div>
                <div className="flex items-center gap-3">
                    <Skeleton className="h-3 w-20 rounded" />
                </div>
            </div>
            <Skeleton className="h-3 w-10 rounded" />
        </CommandItem>
    );
}

function useTokenSearchData(open: boolean, query: string) {
    const trimmedQuery = query.trim();
    const hasQuery = trimmedQuery.length > 0;
    const [recentTokens, setRecentTokens] = useLocalStorage<RecentSolanaTokenEntry[]>('token-search:recent', []);
    const isDesktop = useMediaQuery('(min-width: 768px)');

    const {
        data: topTokensSource = [],
        isLoading: isLoadingTopTokens,
        error: topTokensError,
    } = useCuratedTokens(TOP_TOKENS_LIST_ID, { enabled: open && !hasQuery });
    const { data: dynamicLstMints } = useQuery<string[]>({
        queryKey: ['tokens', 'curated', 'lsts', 'mints'],
        queryFn: ({ signal }) =>
            Effect.runPromise(
                apiJson<CuratedMintResponse>({
                    url: '/api/v1/assets/curated?list=lsts&groupBy=mint',
                }).pipe(
                    Effect.map(data =>
                        Array.from(
                            new Set(
                                (data.assets ?? []).flatMap(asset => {
                                    const mint = asset.primaryVariant?.mint?.trim();
                                    return mint ? [mint] : [];
                                }),
                            ),
                        ),
                    ),
                ),
                { signal },
            ),
        enabled: open,
        staleTime: 60 * 1000,
    });
    const lstMints = React.useMemo(() => new Set(dynamicLstMints ?? []), [dynamicLstMints]);

    const curatedCategoryQueries = useQueries({
        queries: TOKEN_SEARCH_LIST_ORDER.map(listId => ({
            queryKey: ['tokens', 'curated', listId],
            queryFn: ({ signal }: { signal?: AbortSignal }) => fetchCuratedTokens(listId, signal),
            staleTime: 60 * 1000,
            enabled: open && hasQuery,
        })),
    });
    const {
        data: serverSearchTokens = [],
        isLoading: isLoadingServerSearch,
        error: serverSearchError,
    } = useSearchTokens(trimmedQuery, { enabled: open && hasQuery });

    // Recent searches are stored as full Token snapshots in localStorage, so their
    // market data goes stale. Overlay fresh values from already-fetched queries so the
    // palette matches prices shown elsewhere in the app.
    const freshTokensByAddress = React.useMemo(() => {
        const map = new Map<string, Token>();
        for (const token of topTokensSource) map.set(token.address, token);
        for (const token of serverSearchTokens) map.set(token.address, token);
        return map;
    }, [topTokensSource, serverSearchTokens]);

    const recentSearches = React.useMemo(() => {
        const filtered = recentTokens
            .filter(item => !lstMints.has(item.token.address) && tokenMatchesQuery(item.token, query))
            .sort((a, b) => b.selectedAt - a.selectedAt);

        const seen = new Set<string>();
        const unique: RecentSolanaTokenEntry[] = [];

        for (const item of filtered) {
            const address = item.token.address;
            if (seen.has(address)) continue;
            seen.add(address);
            const fresh = freshTokensByAddress.get(address);
            unique.push(fresh ? { ...item, token: fresh } : item);
            if (unique.length >= 8) break;
        }

        return unique;
    }, [freshTokensByAddress, lstMints, query, recentTokens]);

    const topTokens = React.useMemo(() => {
        const filtered = topTokensSource.filter(token => tokenMatchesQuery(token, query));
        if (!isDesktop) return filtered.slice(0, 50);

        const recentAddresses = new Set(
            recentTokens.flatMap(entry => {
                const address = entry.token.address;
                return lstMints.has(address) ? [] : [address];
            }),
        );
        return filtered.filter(token => !recentAddresses.has(token.address)).slice(0, 50);
    }, [isDesktop, lstMints, query, recentTokens, topTokensSource]);

    const isInitialLoadingTopTokens = open && !hasQuery && isLoadingTopTokens && topTokensSource.length === 0;

    const curatedSearchTokens = React.useMemo(() => {
        if (!hasQuery) return [];

        const seen = new Set<string>();
        const matches: Token[] = [];

        for (const queryResult of curatedCategoryQueries) {
            const tokens = queryResult.data ?? [];
            for (const token of tokens) {
                if (seen.has(token.address)) continue;
                seen.add(token.address);
                if (!tokenMatchesQuery(token, query)) continue;
                matches.push(token);
                if (matches.length >= 50) return matches;
            }
        }

        return matches;
    }, [curatedCategoryQueries, hasQuery, query]);

    const hasCuratedSearchError = hasQuery && curatedCategoryQueries.some(result => result.error);
    const searchTokens = React.useMemo(() => {
        if (!hasQuery) return [];

        const seen = new Set<string>();
        const matches: Token[] = [];

        for (const token of [...serverSearchTokens, ...curatedSearchTokens]) {
            const key = (token.assetId ?? '').trim() || token.address;
            if (seen.has(key)) continue;
            seen.add(key);
            matches.push(token);
            if (matches.length >= 50) break;
        }

        return matches;
    }, [curatedSearchTokens, hasQuery, serverSearchTokens]);
    const hasSearchError = hasQuery && Boolean(serverSearchError) && hasCuratedSearchError && searchTokens.length === 0;
    const isInitialLoadingSearch =
        hasQuery &&
        searchTokens.length === 0 &&
        (isLoadingServerSearch || curatedCategoryQueries.some(result => result.isLoading));

    return {
        recentSearches,
        topTokens,
        searchTokens,
        topTokensError,
        hasSearchError,
        isInitialLoadingTopTokens,
        isInitialLoadingSearch,
        setRecentTokens,
    };
}

function TokenCommandRow({ token, onSelect }: { token: Token; onSelect: (token: Token) => Promise<void> }) {
    const tokenDisplayName = cleanTokenName(token.name);

    return (
        <CommandItem
            value={tokenCommandValue(token)}
            onSelect={() => void onSelect(token)}
            className="flex items-center gap-3 px-3 py-2 rounded-2xl"
        >
            <TokenLogo token={token} />
            <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2">
                    <span className="font-medium text-text-extra-high">{tokenDisplayName}</span>
                    <span className="text-sm text-text-low truncate max-w-[180px]">{token.symbol}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-text-extra-low">
                    <span>{formatPrice(token.price)}</span>
                    {token.volume24hUSD > 0 && <span>Vol: {formatLargeNumber(token.volume24hUSD)}</span>}
                </div>
            </div>
            {token.priceChange24hPercent !== 0 && (
                <span
                    className={`text-xs font-medium ${
                        token.priceChange24hPercent > 0 ? 'text-green-600' : 'text-red-600'
                    }`}
                >
                    {token.priceChange24hPercent > 0 ? '+' : ''}
                    {token.priceChange24hPercent.toFixed(2)}%
                </span>
            )}
        </CommandItem>
    );
}

interface TokenSearchDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function TokenSearchDialog({ open, onOpenChange }: TokenSearchDialogProps) {
    const router = useRouter();
    const [query, setQuery] = React.useState('');
    const hasQuery = query.trim().length > 0;

    const {
        recentSearches,
        topTokens,
        searchTokens,
        topTokensError,
        hasSearchError,
        isInitialLoadingTopTokens,
        isInitialLoadingSearch,
        setRecentTokens,
    } = useTokenSearchData(open, query);

    async function handleSelectToken(token: Token): Promise<void> {
        const apiAssetId = token.assetId?.trim() || null;
        const match = getVariantByMint(token.address);
        const registryAssetId = match?.asset.assetId ?? null;
        const registryCoingeckoId = match?.asset.coingeckoId ?? null;

        const assetId = apiAssetId ?? registryAssetId;
        const routeName = assetId ?? token.address;

        setRecentTokens(prev => {
            const next: RecentSolanaTokenEntry[] = [
                { token, selectedAt: Date.now() },
                ...prev.filter(entry => entry.token.address !== token.address),
            ];
            return next.slice(0, 8);
        });

        trackEvent('search_token_selected', {
            token_address: token.address,
            token_symbol: token.symbol,
            token_name: token.name,
            ...(assetId ? { asset_id: assetId } : {}),
            ...(registryCoingeckoId ? { coingecko_id: registryCoingeckoId } : {}),
            search_query: query,
            source: hasQuery ? 'cmdk_search' : 'cmdk_suggested',
        });

        onOpenChange(false);
        setQuery('');
        router.push(`/${encodeURIComponent(routeName)}`);
    }

    function handleOpenChange(nextOpen: boolean) {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
    }

    return (
        <CommandDialog open={open} onOpenChange={handleOpenChange}>
            <CommandInput placeholder="Search tokens..." value={query} onValueChange={setQuery} />

            <CommandList className="h-[400px] max-h-[400px]">
                {(() => {
                    const blocks: React.ReactNode[] = [];

                    if (!hasQuery && recentSearches.length > 0) {
                        blocks.push(
                            <CommandGroup
                                key="recent-searches"
                                heading={
                                    <CommandGroupHeading icon={<Clock className="size-3" />}>
                                        Recent searches
                                    </CommandGroupHeading>
                                }
                            >
                                {recentSearches.map(entry => (
                                    <TokenCommandRow
                                        key={entry.token.address}
                                        token={entry.token}
                                        onSelect={handleSelectToken}
                                    />
                                ))}
                            </CommandGroup>,
                        );
                    }

                    if (hasQuery) {
                        const tokenGroupHeading = (
                            <CommandGroupHeading icon={<Search className="size-3" />}>
                                Search results
                            </CommandGroupHeading>
                        );

                        if (hasSearchError) {
                            blocks.push(
                                <CommandGroup key="curated-search-error" heading={tokenGroupHeading}>
                                    <CommandItem
                                        disabled
                                        value="__curated_search_error__"
                                        className="px-3 py-2 text-text-low"
                                    >
                                        Failed to load search results.
                                    </CommandItem>
                                </CommandGroup>,
                            );
                        } else if (isInitialLoadingSearch) {
                            blocks.push(
                                <CommandGroup key="curated-search-loading" heading={tokenGroupHeading}>
                                    {Array.from({ length: 6 }, (_, index) => (
                                        <TokenSearchItemSkeleton key={index} index={index} />
                                    ))}
                                </CommandGroup>,
                            );
                        } else if (searchTokens.length > 0) {
                            blocks.push(
                                <CommandGroup key="curated-search-results" heading={tokenGroupHeading}>
                                    {searchTokens.map(token => (
                                        <TokenCommandRow key={token.address} token={token} onSelect={handleSelectToken} />
                                    ))}
                                </CommandGroup>,
                            );
                        }
                    }

                    if (!hasQuery) {
                        const tokenGroupHeading = (
                            <CommandGroupHeading icon={<BarChart3 className="size-3" />}>
                                Top by volume
                            </CommandGroupHeading>
                        );

                        if (topTokensError) {
                            blocks.push(
                                <CommandGroup key="tokens-error" heading={tokenGroupHeading}>
                                    <CommandItem disabled value="__tokens_error__" className="px-3 py-2 text-text-low">
                                        Failed to load tokens.
                                    </CommandItem>
                                </CommandGroup>,
                            );
                        } else if (isInitialLoadingTopTokens) {
                            blocks.push(
                                <CommandGroup key="tokens-loading" heading={tokenGroupHeading}>
                                    {Array.from({ length: 6 }, (_, index) => (
                                        <TokenSearchItemSkeleton key={index} index={index} />
                                    ))}
                                </CommandGroup>,
                            );
                        } else if (topTokens.length > 0) {
                            blocks.push(
                                <CommandGroup key="top-tokens" heading={tokenGroupHeading}>
                                    {topTokens.map(token => (
                                        <TokenCommandRow key={token.address} token={token} onSelect={handleSelectToken} />
                                    ))}
                                </CommandGroup>,
                            );
                        }
                    }

                    if (blocks.length === 0) {
                        if (hasQuery) return <CommandEmpty>No results found.</CommandEmpty>;
                        return <CommandEmpty>Start typing to search.</CommandEmpty>;
                    }

                    return blocks;
                })()}
            </CommandList>

            <div className="hidden md:flex w-full justify-center items-center border-t border-border-light px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <ShortcutHint keys={['↑', '↓']} label="List" />
                    <ShortcutHint keys={['Enter']} label="Select" />
                    <ShortcutHint keys={['Esc']} label="Close" />
                </div>
            </div>
        </CommandDialog>
    );
}
