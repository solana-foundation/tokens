'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Badge } from '@tokens/ui/badge';

/**
 * Shared token presentation pieces + v2 lists API response shapes, used by the
 * Lists tab, the ⌘K token search palette, and the metadata sheet.
 */

export interface V2ListToken {
    mint: string;
    symbol: string | null;
    name: string | null;
    logoURI: string | null;
    decimals: number | null;
    verified: boolean;
    rank: number;
    note?: string;
    addedAt?: number;
}

export interface SearchResult {
    mint: string;
    claims: {
        symbol: string | null;
        name: string | null;
        attestations: Array<{ code: string; detail: string }>;
    };
    market: {
        price: number | null;
        liquidityUsd: number | null;
        volume24hUsd: number | null;
        marketCapUsd: number | null;
        priceChange24hPercent: number | null;
        holderCount: number | null;
        decimals: number | null;
        logoURI: string | null;
        dataAsOf: number | null;
    };
    score: { total: number; components: Record<string, number> };
    reasons: string[];
    warnings: string[];
    badges: string[];
    verified: boolean;
    inLists: string[];
}

export interface SuppressedResult {
    mint: string;
    symbol: string | null;
    name: string | null;
    suppressedBy: string[];
    warnings: string[];
}

export interface SearchSources {
    provider: 'ok' | 'degraded' | 'disabled';
    db: 'ok' | 'degraded';
    registry: 'ok';
}

export interface SearchResponse {
    results: SearchResult[];
    suppressed: SuppressedResult[];
    sources: SearchSources;
    latencyMs: number;
    scoringVersion: string;
}

export type PlaygroundFetcher = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;

export function shortMint(mint: string): string {
    return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function formatUsd(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—';
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
    return `$${value.toFixed(2)}`;
}

/** Admin app's formatValue: '—' for null/non-finite, locale string otherwise. */
export function formatValue(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 1 ? 2 : 8 });
}

export function humanize(code: string): string {
    return code.replaceAll('_', ' ');
}

export function formatDate(ms: number | undefined | null): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString();
}

export function WarningChips({ warnings }: { warnings: string[] }) {
    if (warnings.length === 0) return null;
    return (
        <span className="flex flex-wrap gap-1">
            {warnings.map(warning => (
                <Badge key={warning} variant="warning" className="px-1.5 text-[10px]">
                    {humanize(warning)}
                </Badge>
            ))}
        </span>
    );
}

/**
 * Admin curation table's identity cell: logo avatar with initials fallback +
 * symbol/name. `layout="inline"` puts the name beside the symbol on one line
 * (shorter table rows); `"stacked"` keeps the name on its own line, which the
 * search palette and metadata sheet want for their extra child content.
 */
export function TokenIdentity({
    mint,
    symbol,
    name,
    logoURI,
    verified,
    size = 'row',
    layout = 'stacked',
    symbolAccessory,
    symbolClassName,
    nameClassName,
    indicatorClassName,
    children,
}: {
    mint: string;
    symbol: string | null;
    name: React.ReactNode;
    logoURI: string | null;
    verified?: boolean;
    size?: 'row' | 'dialog';
    layout?: 'stacked' | 'inline';
    symbolAccessory?: React.ReactNode;
    symbolClassName?: string;
    nameClassName?: string;
    indicatorClassName?: string;
    children?: React.ReactNode;
}) {
    const avatarSize = size === 'dialog' ? 'h-12 w-12' : layout === 'inline' ? 'h-5 w-5' : 'h-8 w-8';
    const indicatorSize = indicatorClassName ?? (size === 'dialog' ? 'size-3' : 'size-2.5');
    const symbolText = symbol ?? shortMint(mint);
    return (
        <div className="flex items-center gap-3 min-w-0">
            <div className="relative shrink-0">
                <Avatar className={`${avatarSize} ring-2 ring-border/70`}>
                    {logoURI ? (
                        <AvatarImage src={logoURI} alt={symbol ?? mint} loading="lazy" decoding="async" />
                    ) : null}
                    <AvatarFallback className="text-[10px]">{(symbol ?? mint).slice(0, 2)}</AvatarFallback>
                </Avatar>
                {verified !== undefined && (
                    <span
                        role="img"
                        aria-label={verified ? 'Verified token' : 'Unverified token'}
                        title={verified ? 'Verified token' : 'Unverified token'}
                        className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-background ${indicatorSize} ${verified ? 'bg-emerald-500' : 'bg-zinc-400'}`}
                    />
                )}
            </div>
            {layout === 'inline' ? (
                <div className="flex min-w-0 items-center gap-2">
                    <span className={`shrink-0 text-sm font-inter-medium ${symbolClassName ?? ''}`}>{symbolText}</span>
                    {symbolAccessory}
                    <span className={nameClassName ?? 'truncate text-xs text-muted-foreground'}>{name ?? '—'}</span>
                    {children}
                </div>
            ) : (
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={`truncate font-inter-medium ${symbolClassName ?? ''}`}>{symbolText}</span>
                        {symbolAccessory}
                    </div>
                    <div className={nameClassName ?? 'truncate text-sm text-muted-foreground'}>{name ?? '—'}</div>
                    {children}
                </div>
            )}
        </div>
    );
}

/** Admin add-variant-dialog's SummaryField: eyebrow label + value card. */
export function SummaryField({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md border border-border-extra-light bg-white dark:bg-zinc-950/30 px-3 py-2">
            <div className="text-[11px] font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 truncate text-sm font-inter-medium text-foreground">{value}</div>
        </div>
    );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
    return (
        <div className="text-xs font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">{children}</div>
    );
}
