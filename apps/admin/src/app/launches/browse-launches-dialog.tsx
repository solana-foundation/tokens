'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type {
    ApproveLaunchpadMintArgs,
    ApproveLaunchpadMintResult,
    LaunchpadQuoteTokenRow,
    ListLaunchpadTokensForQuoteResult,
    RevokeLaunchpadMintArgs,
    RevokeLaunchpadMintResult,
    SyncLaunchpadMintResult,
} from '@/lib/admin-types';
import { formatRelativeTime } from '@/lib/advisory-labels';
import { formatCompactMint, formatUsdCompact, stonkfunTokenUrl, type LaunchGroup } from '@/lib/launch-labels';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Spinner } from '@tokens/ui/spinner';
import { Badge } from '@solana/design-system/badge';

import { LaunchStateBadges, TokenAvatar, formatPrice } from './launch-bits';

interface BrowseLaunchesDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    group: Pick<LaunchGroup, 'key' | 'asset' | 'quoteMints' | 'quoteSymbol'> | null;
    onApproveWithNote: (mint: string) => void;
}

/**
 * The complete list of graduated coins stonk.fun has for this asset's quote
 * mints, live, including coins below the sync threshold that never reach the
 * table on their own. Approve straight from the list, or open the checked
 * dialog to add a note.
 */
export function BrowseLaunchesDialog({ open, onOpenChange, group, onApproveWithNote }: BrowseLaunchesDialogProps) {
    const listForQuote = useAdminMutation<ListLaunchpadTokensForQuoteResult, { quoteMints: string[] }>(
        'adminListLaunchpadTokensForQuote',
    );
    const approveMint = useAdminMutation<ApproveLaunchpadMintResult, ApproveLaunchpadMintArgs>('approveLaunchpadMint');
    const revokeMint = useAdminMutation<RevokeLaunchpadMintResult, RevokeLaunchpadMintArgs>('revokeLaunchpadMint');
    const syncMint = useAdminMutation<SyncLaunchpadMintResult, { mint: string }>('adminSyncLaunchpadMint');

    const [result, setResult] = useState<ListLaunchpadTokensForQuoteResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [busyMint, setBusyMint] = useState<string | null>(null);

    const quoteMints = group?.quoteMints ?? [];
    const quoteKey = quoteMints.join(',');

    async function load() {
        if (quoteMints.length === 0) return;
        setIsLoading(true);
        setError(null);
        try {
            setResult(await listForQuote({ quoteMints }));
        } catch (err) {
            setResult(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsLoading(false);
        }
    }

    useEffect(() => {
        if (!open) {
            setResult(null);
            setError(null);
            setBusyMint(null);
            return;
        }
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, quoteKey]);

    async function quickApprove(token: LaunchpadQuoteTokenRow) {
        const mint = token.mint;
        const symbol = token.symbol ?? formatCompactMint(mint);
        setBusyMint(mint);
        const toastId = toast.loading(`Approving ${symbol}…`);
        try {
            const res = await approveMint({
                mint,
                quoteMint: token.quoteMint,
                symbol: token.symbol,
                name: token.name,
                logoURI: token.imageUrl,
            });
            let synced: SyncLaunchpadMintResult | null = null;
            if (!token.isActive) {
                try {
                    synced = await syncMint({ mint });
                } catch {
                    synced = null;
                }
            }
            toast.success(
                (res.created ? `Approved ${symbol}.` : `${symbol} was already approved.`) +
                    (synced?.isActive
                        ? ' Live now.'
                        : synced?.reason === 'identity_pending'
                          ? ' Stored; live once identity is available.'
                          : ''),
                { id: toastId },
            );
            setResult(prev =>
                prev
                    ? {
                          ...prev,
                          tokens: prev.tokens.map(t =>
                              t.mint === mint
                                  ? {
                                        ...t,
                                        approved: { note: null, approvedAt: res.approvedAt },
                                        synced: t.synced || !!synced?.synced,
                                        isActive: t.isActive || !!synced?.isActive,
                                    }
                                  : t,
                          ),
                      }
                    : prev,
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
        } finally {
            setBusyMint(null);
        }
    }

    async function quickRevoke(mint: string, symbol: string) {
        setBusyMint(mint);
        const toastId = toast.loading(`Revoking ${symbol}…`);
        try {
            const res = await revokeMint({ mint });
            if (res.revoked) toast.success(`Revoked ${symbol}.`, { id: toastId });
            else toast.message(`${symbol} was not approved.`, { id: toastId });
            setResult(prev =>
                prev
                    ? { ...prev, tokens: prev.tokens.map(t => (t.mint === mint ? { ...t, approved: null } : t)) }
                    : prev,
            );
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
        } finally {
            setBusyMint(null);
        }
    }

    const title = group?.asset?.symbol ?? group?.quoteSymbol ?? 'asset';
    const nowMs = Date.now();
    const approvedCount = result?.tokens.filter(t => t.approved !== null).length ?? 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Launched on {title} — everything on stonk.fun</DialogTitle>
                    <DialogDescription>
                        Live from stonk.fun: every graduated coin quoted in{' '}
                        {quoteMints.length > 1 ? `${quoteMints.length} ${title} mints` : (group?.quoteSymbol ?? title)},
                        including coins below the sync threshold. Approved coins are stored by the next sync regardless
                        of size.
                    </DialogDescription>
                </DialogHeader>

                {group ? (
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                        <div className="flex items-center gap-3">
                            <TokenAvatar imageUrl={group.asset?.imageUrl} label={title} className="h-10 w-10" />
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-inter-semibold">{title}</span>
                                    {group.asset ? <Badge variant="default">{group.asset.assetId}</Badge> : null}
                                    {quoteMints.map(mint => (
                                        <Badge key={mint} variant="info" title={mint}>
                                            {formatCompactMint(mint)}
                                        </Badge>
                                    ))}
                                </div>
                                <div className="truncate text-sm text-muted-foreground">
                                    {group.asset?.name ?? 'Quote mint is not a curated asset'}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                <div className="space-y-3 py-2">
                    {isLoading ? (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                            <Spinner className="h-4 w-4" /> Fetching launches from stonk.fun…
                        </div>
                    ) : null}
                    {error ? (
                        <Alert variant="destructive">
                            <AlertTitle>Unable to load from stonk.fun</AlertTitle>
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}
                    {result && !isLoading ? (
                        result.tokens.length === 0 ? (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                                stonk.fun has no graduated coins for {title} right now.
                            </div>
                        ) : (
                            <>
                                <div className="text-xs text-muted-foreground">
                                    {result.tokens.length} coins · {approvedCount} approved · fetched{' '}
                                    {formatRelativeTime(result.fetchedAt, nowMs)}
                                </div>
                                {result.tokens.map(token => {
                                    const symbol = token.symbol ?? formatCompactMint(token.mint);
                                    const busy = busyMint === token.mint;
                                    return (
                                        <div
                                            key={token.mint}
                                            className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_auto] items-center gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3"
                                        >
                                            <div className="flex min-w-0 items-center gap-3">
                                                <TokenAvatar imageUrl={token.imageUrl} label={symbol} />
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <span className="truncate font-inter-medium">{symbol}</span>
                                                        <LaunchStateBadges
                                                            approved={token.approved !== null}
                                                            synced={token.synced}
                                                            isActive={token.isActive}
                                                            meetsThreshold={token.meetsThreshold}
                                                            status={token.status}
                                                        />
                                                    </div>
                                                    <div className="truncate text-sm text-muted-foreground">
                                                        {token.name ?? '—'}
                                                    </div>
                                                    <a
                                                        href={stonkfunTokenUrl(token.mint)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="font-mono text-xs text-muted-foreground hover:underline"
                                                        title={token.mint}
                                                    >
                                                        {formatCompactMint(token.mint)} ↗
                                                    </a>
                                                </div>
                                            </div>
                                            <div className="min-w-0 space-y-0.5 text-sm">
                                                <div>
                                                    <span className="text-muted-foreground">Mkt cap</span>{' '}
                                                    <span className="tabular-nums">
                                                        {formatUsdCompact(token.market.marketCapUsd)}
                                                    </span>
                                                </div>
                                                <div>
                                                    <span className="text-muted-foreground">Vol 24h</span>{' '}
                                                    <span className="tabular-nums">
                                                        {formatUsdCompact(token.market.volume24hUsd)}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {formatPrice(token.market.priceUsd)}
                                                    {token.graduatedAt
                                                        ? ` · graduated ${formatRelativeTime(token.graduatedAt, nowMs)}`
                                                        : ''}
                                                </div>
                                            </div>
                                            <div className="flex items-center justify-end gap-2">
                                                {token.approved ? (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={() => void quickRevoke(token.mint, symbol)}
                                                    >
                                                        {busy ? 'Revoking…' : 'Revoke'}
                                                    </Button>
                                                ) : (
                                                    <>
                                                        <Button
                                                            size="sm"
                                                            disabled={busy || !group?.asset}
                                                            onClick={() => void quickApprove(token)}
                                                        >
                                                            {busy ? 'Approving…' : 'Approve'}
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={busy}
                                                            onClick={() => onApproveWithNote(token.mint)}
                                                        >
                                                            With note…
                                                        </Button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </>
                        )
                    ) : null}
                </div>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => void load()}
                        disabled={isLoading || quoteMints.length === 0}
                    >
                        Refresh
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
