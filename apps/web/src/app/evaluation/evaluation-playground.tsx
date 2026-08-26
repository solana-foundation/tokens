'use client';

import Image from 'next/image';
import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';

import { listAssets, type AssetCategory } from '@tokens/asset-registry';
import { CURATED_TOKEN_LISTS } from '@tokens/asset-registry/compat';
import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@tokens/ui/select';

import { QuoteComparisonTable } from './quote-comparison-table';
import {
    buildEvaluateRequestPath,
    useExecutionEvaluation,
    type ExecutionQuoteSide,
} from '@/hooks/queries/use-execution-evaluation';
import {
    buildEvaluateFetchSnippet,
    buildRouteFetchSnippet,
    EndpointRequestPanel,
    type EndpointRequestState,
} from './endpoint-request-panel';
import { RouteResults } from './route-results';
import { buildRouteRequestPath, useExecutionRoute } from '@/hooks/queries/use-execution-route';
import { CURATED_LIST_ORDER_WITHOUT_LSTS, type CuratedTokenListIdWithoutLsts } from '@/lib/curated-token-lists';
import { cleanTokenName } from '@/lib/logo-overrides';
import { trackEvent } from '@/lib/posthog-client';

/**
 * The size curve this page exists to show: where a router's edge appears and
 * where liquidity gives out are only legible across rungs, so we ask for all
 * eight rather than the endpoint's cheaper three-rung default.
 *
 * Eight plus a custom amount is exactly the endpoint's nine-amount cap, so
 * adding a rung here without raising MAX_AMOUNTS would start returning 400.
 */
const BUY_TIERS = ['10000', '25000', '50000', '100000', '250000', '500000', '1000000', '5000000'] as const;

const FALLBACK_LIST_BY_CATEGORY: Partial<Record<AssetCategory, CuratedTokenListIdWithoutLsts>> = {
    crypto: 'majors',
    stablecoin: 'currencies',
    rwa: 'rwas',
    etf: 'etfs',
    index: 'etfs',
    commodity: 'metals',
    equity: 'stocks',
};

interface MintOption {
    assetId: string;
    logoURI?: string;
    mint: string;
    name: string;
    symbol: string;
}

interface MintOptionGroup {
    id: CuratedTokenListIdWithoutLsts;
    label: string;
    options: MintOption[];
}

interface CuratedMintMetadataResponse {
    assets?: Array<{
        assetId: string;
        name?: string | null;
        symbol?: string | null;
        imageUrl?: string | null;
        primaryVariant?: {
            mint: string;
            label?: string | null;
            name?: string | null;
            symbol?: string | null;
            market?: {
                logoURI?: string | null;
            } | null;
        } | null;
    }>;
}

async function fetchCuratedMintMetadata(
    listId: CuratedTokenListIdWithoutLsts,
    signal: AbortSignal,
): Promise<MintOption[]> {
    const response = await fetch(`/api/v1/assets/curated?list=${encodeURIComponent(listId)}&groupBy=mint`, { signal });
    if (!response.ok) throw new Error(`Failed to load ${listId} mint metadata (${response.status})`);

    const data = (await response.json()) as CuratedMintMetadataResponse;
    return (data.assets ?? []).flatMap(asset => {
        const variant = asset.primaryVariant;
        if (!variant?.mint) return [];

        // Market logos are populated by the assets pipeline from Birdeye. The
        // canonical image is a fallback for assets whose primary market row
        // does not expose one.
        const logoURI = (variant.market?.logoURI ?? asset.imageUrl ?? '').trim();
        const symbol = (variant.symbol ?? variant.label ?? asset.symbol ?? variant.mint.slice(0, 4)).trim();
        const name = cleanTokenName((variant.name ?? variant.label ?? asset.name ?? symbol).trim());
        return [
            {
                assetId: asset.assetId,
                ...(logoURI ? { logoURI } : {}),
                mint: variant.mint,
                name,
                symbol,
            },
        ];
    });
}

function buildMintOptionGroups(): MintOptionGroup[] {
    const groups = CURATED_LIST_ORDER_WITHOUT_LSTS.map(id => ({
        id,
        label: CURATED_TOKEN_LISTS[id].name,
        mints: new Set<string>(CURATED_TOKEN_LISTS[id].addresses),
        options: [] as MintOption[],
    }));
    const seenMints = new Set<string>();

    for (const asset of listAssets()) {
        if (asset.variants.length === 0) continue;

        // Match the same curated lists that power the homepage tabs. A small
        // number of registry-only assets fall back to their equivalent tab so
        // the selector does not lose options that were previously available.
        const matchedGroup = groups.find(group => asset.variants.some(variant => group.mints.has(variant.mint)));
        const groupId = matchedGroup?.id ?? FALLBACK_LIST_BY_CATEGORY[asset.category];
        if (!groupId) continue;

        const group = groups.find(entry => entry.id === groupId);
        for (const variant of asset.variants) {
            if (seenMints.has(variant.mint)) continue;
            seenMints.add(variant.mint);

            const symbol = variant.symbol?.trim() || variant.label?.trim() || asset.symbol?.trim() || asset.assetId;
            const name = cleanTokenName(variant.name?.trim() || variant.label?.trim() || asset.name?.trim() || symbol);
            group?.options.push({
                assetId: asset.assetId,
                mint: variant.mint,
                name,
                symbol,
            });
        }
    }

    return groups.map(({ mints: _mints, ...group }) => ({
        ...group,
        options: group.options.sort((a, b) => a.name.localeCompare(b.name) || a.symbol.localeCompare(b.symbol)),
    }));
}

function MintOptionLogo({ option }: { option: MintOption }) {
    const [hasError, setHasError] = React.useState(false);

    if (!option.logoURI || hasError) {
        return (
            <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-gray-1400 text-[10px] font-bold text-white">
                {option.symbol.slice(0, 2).toUpperCase()}
            </span>
        );
    }

    return (
        <Image
            src={option.logoURI}
            alt=""
            width={26}
            height={26}
            className="size-[26px] shrink-0 rounded-full bg-gray-50 object-cover"
            loading="lazy"
            decoding="async"
            onError={() => setHasError(true)}
            referrerPolicy="no-referrer"
        />
    );
}

function shortMint(mint: string): string {
    return `${mint.slice(0, 5)}…${mint.slice(-5)}`;
}

function MintOptionRow({ option }: { option: MintOption }) {
    return (
        <span className="flex w-full min-w-0 items-center gap-2 text-left">
            <MintOptionLogo key={option.mint} option={option} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-[16px] font-medium text-text-extra-high">{option.name}</span>
                    <span className="shrink-0 text-[14px] font-medium text-text-extra-low">${option.symbol}</span>
                </span>
                <span className="truncate font-mono text-[10px] leading-tight text-text-extra-low">
                    {shortMint(option.mint)}
                </span>
            </span>
        </span>
    );
}

function normalizeAmountInput(raw: string): string | null {
    const value = raw.replace(/[$,\s]/g, '');
    const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
    if (!match) return null;
    const fraction = (match[2] ?? '').replace(/0+$/, '');
    const whole = match[1].replace(/^0+(?=\d)/, '');
    const normalized = fraction ? `${whole}.${fraction}` : whole;
    return Number(normalized) > 0 ? normalized : null;
}

/**
 * Assets worth routing across: at least two variants in the registry. Sorted
 * by variant count so the assets where splitting matters most lead the list.
 */
interface AssetOption {
    assetId: string;
    name: string;
    symbol: string;
    variantCount: number;
    /** The mint whose curated metadata (logo) represents this asset. */
    logoMint: string;
}

interface AssetOptionGroup {
    id: CuratedTokenListIdWithoutLsts;
    label: string;
    options: AssetOption[];
}

/**
 * One option per canonical asset, grouped by the same curated lists as the
 * mint selector — the canonicals we maintain per list, so testing across
 * categories is one scroll. Single-variant assets stay listed (they route as
 * single-leg plans); the variant count makes the difference obvious.
 */
function buildAssetOptionGroups(): AssetOptionGroup[] {
    const groups = CURATED_LIST_ORDER_WITHOUT_LSTS.map(id => ({
        id,
        label: CURATED_TOKEN_LISTS[id].name,
        mints: new Set<string>(CURATED_TOKEN_LISTS[id].addresses),
        options: [] as AssetOption[],
    }));

    for (const asset of listAssets()) {
        if (asset.variants.length === 0) continue;
        const matchedGroup = groups.find(group => asset.variants.some(variant => group.mints.has(variant.mint)));
        const groupId = matchedGroup?.id ?? FALLBACK_LIST_BY_CATEGORY[asset.category];
        if (!groupId) continue;
        const group = groups.find(entry => entry.id === groupId);
        if (!group) continue;
        // Prefer a curated-listed mint for the logo — it is the one the
        // metadata queries will have hydrated.
        const logoMint = asset.variants.find(variant => group.mints.has(variant.mint))?.mint ?? asset.variants[0]!.mint;
        const symbol = asset.symbol?.trim() || asset.assetId;
        group.options.push({
            assetId: asset.assetId,
            name: cleanTokenName(asset.name?.trim() || symbol),
            symbol,
            variantCount: asset.variants.length,
            logoMint,
        });
    }

    return groups.map(({ mints: _mints, ...group }) => ({
        ...group,
        options: group.options.sort((a, b) => b.variantCount - a.variantCount || a.name.localeCompare(b.name)),
    }));
}

function AssetOptionRow({ option, logo }: { option: AssetOption; logo: MintOption | undefined }) {
    return (
        <span className="flex w-full min-w-0 items-center gap-2 text-left">
            <MintOptionLogo
                key={option.logoMint}
                option={
                    logo ?? { assetId: option.assetId, mint: option.logoMint, name: option.name, symbol: option.symbol }
                }
            />
            <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate text-[16px] font-medium text-text-extra-high">{option.name}</span>
                <span className="shrink-0 text-[14px] font-medium text-text-extra-low">${option.symbol}</span>
                <span className="ml-auto shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-text-medium">
                    {option.variantCount} {option.variantCount === 1 ? 'variant' : 'variants'}
                </span>
            </span>
        </span>
    );
}

type PlaygroundMode = 'mint' | 'asset';

/** Exact-mint, uncached Titan and Jupiter quote playground. */
export function EvaluationPlayground() {
    const [mode, setMode] = React.useState<PlaygroundMode>('mint');
    const [selectedMint, setSelectedMint] = React.useState('cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij');
    const [side, setSide] = React.useState<ExecutionQuoteSide>('buy');
    const [amountInput, setAmountInput] = React.useState('');
    const [amountError, setAmountError] = React.useState<string | null>(null);
    const [requestedAmounts, setRequestedAmounts] = React.useState<string[]>([]);
    const [submittedCustom, setSubmittedCustom] = React.useState<string | null>(null);
    const { data, execute, isError, isPending, reset } = useExecutionEvaluation();
    const [lastRequest, setLastRequest] = React.useState<EndpointRequestState | null>(null);
    const [selectedAssetId, setSelectedAssetId] = React.useState('bitcoin');
    const [targetInput, setTargetInput] = React.useState('1,000,000');
    const [targetError, setTargetError] = React.useState<string | null>(null);
    const routeQuery = useExecutionRoute();
    const [routeLastRequest, setRouteLastRequest] = React.useState<EndpointRequestState | null>(null);
    const baseOptionGroups = React.useMemo(buildMintOptionGroups, []);
    const metadataQueries = useQueries({
        queries: CURATED_LIST_ORDER_WITHOUT_LSTS.map(listId => ({
            queryKey: ['evaluation', 'mint-metadata', listId],
            queryFn: ({ signal }: { signal: AbortSignal }) => fetchCuratedMintMetadata(listId, signal),
            staleTime: 5 * 60 * 1000,
        })),
    });
    const metadataByMint = new Map<string, MintOption>();
    for (const query of metadataQueries) {
        for (const metadata of query.data ?? []) {
            if (!metadataByMint.has(metadata.mint)) metadataByMint.set(metadata.mint, metadata);
        }
    }
    // Declared after metadataByMint: the asset rows borrow the mint
    // selector's already-hydrated logos, so this must read a populated map.
    const baseAssetGroups = React.useMemo(buildAssetOptionGroups, []);
    const assetGroups = baseAssetGroups.map(group => ({
        ...group,
        options: group.options.map(option => ({ option, logo: metadataByMint.get(option.logoMint) })),
    }));
    const selectedAssetOption = React.useMemo(() => {
        for (const group of baseAssetGroups) {
            const match = group.options.find(option => option.assetId === selectedAssetId);
            if (match) return match;
        }
        return undefined;
    }, [baseAssetGroups, selectedAssetId]);

    const optionGroups = baseOptionGroups.map(group => ({
        ...group,
        options: group.options.map(option => {
            const metadata = metadataByMint.get(option.mint);
            return metadata ? { ...option, ...metadata } : option;
        }),
    }));
    const selectedOption = React.useMemo(
        () => optionGroups.flatMap(group => group.options).find(option => option.mint === selectedMint),
        [optionGroups, selectedMint],
    );

    const requestQuotes = React.useCallback(
        async (amounts: string[], includesCustom: boolean) => {
            setRequestedAmounts(amounts);
            trackEvent('execution_quotes_requested', {
                mint: selectedMint,
                side,
                requested_count: amounts.length,
                includes_custom_amount: includesCustom,
                providers_requested: 2,
            });
            const startedAt = performance.now();
            try {
                const response = await execute({ mint: selectedMint, side, amounts });
                setLastRequest({
                    durationMs: Math.round(performance.now() - startedAt),
                    status: response ? 200 : 'error',
                });
                if (response) {
                    trackEvent('execution_quotes_completed', {
                        mint: selectedMint,
                        side,
                        requested_count: response.meta.requested,
                        available_count: response.meta.available,
                        unavailable_count: response.meta.unavailable,
                        jupiter_available_count: response.meta.providerStats.jupiter.quoted,
                        titan_available_count: response.meta.providerStats.titan.quoted,
                        jupiter_win_count: response.meta.providerStats.jupiter.wins,
                        titan_win_count: response.meta.providerStats.titan.wins,
                        comparable_count: response.meta.summary.comparableEntries,
                        best_provider: response.meta.summary.bestProvider,
                        median_edge_bps: response.meta.summary.medianEdgeBps,
                        request_latency_ms: Math.round(performance.now() - startedAt),
                    });
                }
            } catch {
                // The hook owns the visible error state; no stale response is retained.
            }
        },
        [execute, selectedMint, side],
    );

    // Changing the mint or side clears the table but does NOT auto-fetch: each
    // request is amounts x providers real upstream quotes, so it waits for a
    // deliberate submit rather than firing on every dropdown change.
    React.useEffect(() => {
        setAmountInput('');
        setAmountError(null);
        setSubmittedCustom(null);
        setRequestedAmounts([]);
        setLastRequest(null);
        reset();
    }, [selectedMint, side, reset]);

    // What a submit right now would ask for. Drives both the request and the
    // snippet beside it, so the code updates live as the form changes.
    const pendingAmounts = React.useMemo(() => {
        const custom = normalizeAmountInput(amountInput);
        if (side === 'sell') return custom ? [custom] : [];
        // A custom amount joins the curve rather than replacing it, so it can be
        // read against the neighbouring rungs. Deduped: typing a size that is
        // already a tier must not spend a second quote on it.
        return [...new Set([...BUY_TIERS, ...(custom ? [custom] : [])])];
    }, [amountInput, side]);
    const requestPath = buildEvaluateRequestPath({ mint: selectedMint, side, amounts: pendingAmounts });

    const normalizedTarget = normalizeAmountInput(targetInput);
    const routeRequestPath = buildRouteRequestPath({
        assetId: selectedAssetId,
        amountUsd: normalizedTarget ?? '1000000',
    });

    const onRouteSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!normalizedTarget || normalizedTarget.includes('.')) {
            setTargetError('Enter a whole-dollar target.');
            return;
        }
        setTargetError(null);
        trackEvent('execution_route_requested', {
            asset_id: selectedAssetId,
            target_usd: Number(normalizedTarget),
        });
        const startedAt = performance.now();
        const response = await routeQuery.execute({ assetId: selectedAssetId, amountUsd: normalizedTarget });
        setRouteLastRequest({
            durationMs: Math.round(performance.now() - startedAt),
            status: response ? 200 : 'error',
        });
        if (response) {
            trackEvent('execution_route_completed', {
                asset_id: selectedAssetId,
                target_usd: Number(normalizedTarget),
                allocation_status: response.allocationStatus,
                selected_variants: response.meta.selectedVariants,
                leg_count: response.allocation?.legs.length ?? 0,
                edge_vs_best_single_bps: response.allocation?.edge.vsBestSingleVariant?.bps ?? null,
                upstream_quotes: response.meta.upstreamQuotes,
                request_latency_ms: Math.round(performance.now() - startedAt),
            });
        }
    };

    const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const custom = normalizeAmountInput(amountInput);
        if (side === 'sell' && !custom) {
            setAmountError('Enter a positive token amount.');
            return;
        }
        if (amountInput.trim() && !custom) {
            setAmountError('Enter a positive amount.');
            return;
        }
        setAmountError(null);
        setSubmittedCustom(custom);
        void requestQuotes(pendingAmounts, custom !== null);
    };

    return (
        <main className="flex min-h-screen justify-center bg-[#FAFAFA] px-4 py-20">
            <div className="w-full max-w-[1440px] space-y-6">
                {/* One column of results, one of the request that produced them.
                    Splits at xl only: the table needs ~980px, so below that the
                    two side by side would just make the table scroll. */}
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
                    <div className="min-w-0 space-y-6">
                        <div className="inline-flex rounded-full border border-border-medium bg-gray-50 p-1">
                            {(
                                [
                                    ['mint', 'Single mint'],
                                    ['asset', 'Route an asset'],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={mode === value}
                                    className={`min-w-28 rounded-full px-4 py-2 text-[13px] font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none ${
                                        mode === value
                                            ? 'bg-white text-text-extra-high shadow-sm'
                                            : 'text-text-medium hover:text-text-high'
                                    }`}
                                    onClick={() => setMode(value)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {mode === 'asset' ? (
                            <form
                                className="rounded-2xl border border-border-light bg-white p-4 shadow-[0_8px_40px_rgba(0,0,0,0.03)]"
                                onSubmit={onRouteSubmit}
                            >
                                <label
                                    htmlFor="execution-route-asset"
                                    className="mb-2 block text-[11px] font-normal text-text-medium"
                                >
                                    Canonical asset
                                </label>
                                <Select value={selectedAssetId} onValueChange={setSelectedAssetId}>
                                    <SelectTrigger
                                        id="execution-route-asset"
                                        className="h-[52px] border-border-medium bg-white text-left text-text-extra-high shadow-none focus:ring-border-medium [&>span]:!flex [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left"
                                    >
                                        <SelectValue placeholder="Select an asset">
                                            {selectedAssetOption ? (
                                                <AssetOptionRow
                                                    option={selectedAssetOption}
                                                    logo={metadataByMint.get(selectedAssetOption.logoMint)}
                                                />
                                            ) : null}
                                        </SelectValue>
                                    </SelectTrigger>
                                    <SelectContent className="rounded-xl border-border-light [&>[aria-hidden=true]]:py-0 [&>div[data-radix-select-viewport]]:!pt-0">
                                        {assetGroups.map((group, index) => (
                                            <React.Fragment key={group.id}>
                                                {index > 0 ? (
                                                    <SelectSeparator className="my-0.5 bg-border-extra-light" />
                                                ) : null}
                                                <SelectGroup>
                                                    <SelectLabel className="sticky top-0 z-10 block border-b border-border-extra-light bg-white px-2 py-1 text-[11px] font-semibold text-text-medium">
                                                        {group.label}
                                                    </SelectLabel>
                                                    {group.options.map(({ option, logo }) => (
                                                        <SelectItem
                                                            key={option.assetId}
                                                            value={option.assetId}
                                                            textValue={`${option.name} ${option.symbol} ${option.assetId}`}
                                                            className="py-2"
                                                        >
                                                            <AssetOptionRow option={option} logo={logo} />
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            </React.Fragment>
                                        ))}
                                    </SelectContent>
                                </Select>

                                <label
                                    htmlFor="execution-route-target"
                                    className="mt-4 mb-2 block text-[11px] font-normal text-text-medium"
                                >
                                    Order size (USD)
                                </label>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                    <div className="relative flex-1">
                                        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-body-md text-text-medium">
                                            $
                                        </span>
                                        <Input
                                            id="execution-route-target"
                                            inputMode="numeric"
                                            placeholder="5,000,000"
                                            className="pl-7 tabular-nums"
                                            value={targetInput}
                                            aria-invalid={targetError !== null}
                                            onChange={event => {
                                                setTargetInput(event.target.value);
                                                setTargetError(null);
                                            }}
                                        />
                                    </div>
                                    <Button
                                        type="submit"
                                        className="min-w-36"
                                        disabled={routeQuery.isPending || !targetInput.trim()}
                                    >
                                        <RefreshCw
                                            className={
                                                routeQuery.isPending ? 'animate-spin motion-reduce:animate-none' : ''
                                            }
                                        />
                                        {routeQuery.isPending
                                            ? 'Routing…'
                                            : routeQuery.data
                                              ? 'Re-route'
                                              : 'Get the route'}
                                    </Button>
                                </div>
                                {targetError ? <p className="mt-2 text-[11px] text-red-700">{targetError}</p> : null}
                            </form>
                        ) : null}

                        {mode === 'asset' ? (
                            <RouteResults
                                data={routeQuery.data}
                                isPending={routeQuery.isPending}
                                isError={routeQuery.isError}
                            />
                        ) : null}

                        <form
                            className={`rounded-2xl border border-border-light bg-white p-4 shadow-[0_8px_40px_rgba(0,0,0,0.03)] ${mode === 'asset' ? 'hidden' : ''}`}
                            onSubmit={onSubmit}
                        >
                            <fieldset>
                                <legend className="mb-2 text-[11px] font-normal text-text-medium">Trade side</legend>
                                <div className="inline-flex rounded-full border border-border-medium bg-gray-50 p-1">
                                    {(['buy', 'sell'] as const).map(value => (
                                        <button
                                            key={value}
                                            type="button"
                                            aria-pressed={side === value}
                                            className={`min-w-20 rounded-full px-4 py-2 text-[13px] font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none ${
                                                side === value
                                                    ? 'bg-white text-text-extra-high shadow-sm'
                                                    : 'text-text-medium hover:text-text-high'
                                            }`}
                                            onClick={() => setSide(value)}
                                        >
                                            {value === 'buy' ? 'Buy' : 'Sell'}
                                        </button>
                                    ))}
                                </div>
                            </fieldset>

                            <label
                                id="evaluation-asset-label"
                                className="mt-4 mb-2 block text-[11px] font-normal text-text-medium"
                            >
                                Token mint
                            </label>
                            <Select value={selectedMint} onValueChange={setSelectedMint}>
                                <SelectTrigger
                                    aria-labelledby="evaluation-asset-label"
                                    className="h-[52px] border-border-medium bg-white text-left text-text-extra-high shadow-none focus:ring-border-medium [&>span]:!flex [&>span]:min-w-0 [&>span]:flex-1 [&>span]:text-left"
                                >
                                    <SelectValue placeholder="Select a mint">
                                        {selectedOption ? <MintOptionRow option={selectedOption} /> : null}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="rounded-xl border-border-light [&>[aria-hidden=true]]:py-0 [&>div[data-radix-select-viewport]]:!pt-0">
                                    {optionGroups.map((group, index) => (
                                        <React.Fragment key={group.id}>
                                            {index > 0 ? (
                                                <SelectSeparator className="my-0.5 bg-border-extra-light" />
                                            ) : null}
                                            <SelectGroup>
                                                <SelectLabel className="sticky top-0 z-10 block border-b border-border-extra-light bg-white px-2 py-1 text-[11px] font-semibold text-text-medium">
                                                    {group.label}
                                                </SelectLabel>
                                                {group.options.map(option => (
                                                    <SelectItem
                                                        key={option.mint}
                                                        value={option.mint}
                                                        textValue={`${option.name} ${option.symbol} ${option.mint}`}
                                                        className="py-2"
                                                    >
                                                        <MintOptionRow option={option} />
                                                    </SelectItem>
                                                ))}
                                            </SelectGroup>
                                        </React.Fragment>
                                    ))}
                                </SelectContent>
                            </Select>

                            <label
                                htmlFor="execution-eval-amount"
                                className="mt-4 mb-2 block text-[11px] font-normal text-text-medium"
                            >
                                {side === 'buy'
                                    ? 'Custom buy amount (USD, optional)'
                                    : `Amount to sell (${selectedOption?.symbol ?? 'tokens'})`}
                            </label>
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <div className="relative flex-1">
                                    {side === 'buy' ? (
                                        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-body-md text-text-medium">
                                            $
                                        </span>
                                    ) : null}
                                    <Input
                                        id="execution-eval-amount"
                                        inputMode="decimal"
                                        placeholder={side === 'buy' ? '750,000' : '12.5'}
                                        className={`${side === 'buy' ? 'pl-7' : ''} tabular-nums`}
                                        value={amountInput}
                                        aria-invalid={amountError !== null}
                                        onChange={event => {
                                            setAmountInput(event.target.value);
                                            setAmountError(null);
                                        }}
                                    />
                                </div>
                                <Button
                                    type="submit"
                                    className="min-w-36"
                                    disabled={isPending || (side === 'sell' && !amountInput.trim())}
                                >
                                    <RefreshCw className={isPending ? 'animate-spin motion-reduce:animate-none' : ''} />
                                    {isPending ? 'Getting quotes…' : data ? 'Refresh quotes' : 'Get quotes'}
                                </Button>
                            </div>
                            {amountError ? <p className="mt-2 text-[11px] text-red-700">{amountError}</p> : null}
                        </form>

                        {mode === 'mint' ? (
                            <QuoteComparisonTable
                                data={data}
                                isPending={isPending}
                                isError={isError}
                                requestedAmounts={requestedAmounts}
                                customAmount={submittedCustom}
                                side={side}
                            />
                        ) : null}
                    </div>

                    {/* Sticky so the request stays in view while the curve scrolls. */}
                    <div className="min-w-0 xl:sticky xl:top-8">
                        {mode === 'asset' ? (
                            <EndpointRequestPanel
                                snippet={buildRouteFetchSnippet(routeRequestPath)}
                                responseJson={routeQuery.data}
                                isPending={routeQuery.isPending}
                                isError={routeQuery.isError}
                                lastRequest={routeLastRequest}
                            />
                        ) : (
                            <EndpointRequestPanel
                                snippet={buildEvaluateFetchSnippet(requestPath)}
                                responseJson={data}
                                isPending={isPending}
                                isError={isError}
                                lastRequest={lastRequest}
                            />
                        )}
                    </div>
                </div>
            </div>
        </main>
    );
}
