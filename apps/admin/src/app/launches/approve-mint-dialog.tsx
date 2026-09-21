'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type {
    ApproveLaunchpadMintArgs,
    ApproveLaunchpadMintResult,
    LaunchpadMintPreview,
    SyncLaunchpadMintResult,
} from '@/lib/admin-types';
import { formatRelativeTime } from '@/lib/advisory-labels';
import { LAUNCH_NOTE_MAX_LENGTH, formatCompactMint, stonkfunTokenUrl, validateLaunchNote } from '@/lib/launch-labels';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Spinner } from '@tokens/ui/spinner';
import { Badge } from '@solana/design-system/badge';

import { CopyButton, LaunchStateBadges, MarketSummary, SummaryField, TokenAvatar } from './launch-bits';

const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ApproveMintContext {
    assetId: string;
    symbol: string;
    name: string | null;
    quoteMints: string[];
}

interface ApproveMintDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Prefill (from a row action); the check runs automatically on open. */
    initialMint?: string | null;
    /** The asset row the admin started from; the preview is cross-checked against it. */
    context?: ApproveMintContext | null;
    onApproved?: (result: ApproveLaunchpadMintResult) => void;
}

/**
 * Curation's add-variant flow for launchpad coins: paste a mint, Check it on
 * stonk.fun, review what it is and which asset page it lands on, then Approve.
 */
export function ApproveMintDialog({
    open,
    onOpenChange,
    initialMint = null,
    context = null,
    onApproved,
}: ApproveMintDialogProps) {
    const previewMint = useAdminMutation<LaunchpadMintPreview, { mint: string }>('adminPreviewLaunchpadMint');
    const approveMint = useAdminMutation<ApproveLaunchpadMintResult, ApproveLaunchpadMintArgs>('approveLaunchpadMint');
    const syncMint = useAdminMutation<SyncLaunchpadMintResult, { mint: string }>('adminSyncLaunchpadMint');

    const [mint, setMint] = useState('');
    const [preview, setPreview] = useState<LaunchpadMintPreview | null>(null);
    const [checkError, setCheckError] = useState<string | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [note, setNote] = useState('');
    const [autoCheckedFor, setAutoCheckedFor] = useState<string | null>(null);

    const trimmedMint = mint.trim();
    const hasMint = trimmedMint.length > 0;
    const isValidMint = MINT_REGEX.test(trimmedMint);
    const mintError = useMemo(
        () => (!hasMint ? null : !isValidMint ? 'Not a valid Solana mint address.' : null),
        [hasMint, isValidMint],
    );
    const canCheck = isValidMint && !isChecking && !isSubmitting;
    const canApprove = !!preview && preview.found && !!preview.quote?.curated && !isChecking && !isSubmitting;
    const contextMismatch =
        !!context && !!preview?.quote?.asset && preview.quote.asset.assetId !== context.assetId
            ? preview.quote.asset
            : null;

    function resetChecked() {
        setPreview(null);
        setCheckError(null);
        setNote('');
    }

    async function runCheck(target: string) {
        setIsChecking(true);
        setCheckError(null);
        try {
            const result = await previewMint({ mint: target });
            setPreview(result);
            setNote(result.approved?.note ?? '');
        } catch (error) {
            setPreview(null);
            setCheckError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsChecking(false);
        }
    }

    useEffect(() => {
        if (!open) {
            setMint('');
            resetChecked();
            setIsChecking(false);
            setIsSubmitting(false);
            setAutoCheckedFor(null);
            return;
        }
        if (initialMint && MINT_REGEX.test(initialMint) && autoCheckedFor !== initialMint) {
            setMint(initialMint);
            setAutoCheckedFor(initialMint);
            void runCheck(initialMint);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialMint]);

    async function onSubmit() {
        if (!preview || !canApprove) return;
        const validation = validateLaunchNote(note);
        if (!validation.ok) {
            toast.error(validation.error);
            return;
        }
        setIsSubmitting(true);
        const label = preview.token?.symbol ?? formatCompactMint(preview.mint);
        const toastId = toast.loading(`Approving ${label}…`);
        try {
            const result = await approveMint({
                mint: preview.mint,
                note: validation.note,
                quoteMint: preview.quote?.mint ?? null,
                symbol: preview.token?.symbol ?? null,
                name: preview.token?.name ?? null,
                logoURI: preview.token?.imageUrl ?? null,
            });
            // Populate the asset row right away instead of waiting for the cron.
            let syncNote = '';
            if (!preview.isActive) {
                try {
                    const synced = await syncMint({ mint: preview.mint });
                    syncNote = synced.isActive
                        ? ' Live now.'
                        : synced.reason === 'identity_pending'
                          ? ' Stored; goes live once Birdeye identity is available.'
                          : '';
                } catch {
                    syncNote = ' It will be stored by the next sync.';
                }
            }
            toast.success(
                (result.created
                    ? `Approved ${label}${preview.quote?.asset?.symbol ? ` on ${preview.quote.asset.symbol}` : ''}.`
                    : `Updated approval for ${label}.`) + syncNote,
                { id: toastId },
            );
            onApproved?.(result);
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{context ? `Add mint to ${context.symbol}` : 'Approve launch'}</DialogTitle>
                    <DialogDescription>
                        {context
                            ? `Check a stonk.fun mint launched against ${context.symbol}; once approved it appears in the ${context.symbol} row and on its page.`
                            : 'Check a mint on stonk.fun, review what it is and which asset page it would appear on, then approve it for the public site.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 py-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="launch-mint">Mint address</Label>
                        <div className="flex gap-2">
                            <Input
                                id="launch-mint"
                                value={mint}
                                onChange={event => setMint(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter' && canCheck) void runCheck(trimmedMint);
                                }}
                                placeholder="Paste a Solana mint (base58)"
                                disabled={isChecking || isSubmitting || !!preview}
                                spellCheck={false}
                                autoFocus={!initialMint}
                            />
                            <Button
                                type="button"
                                className="shrink-0"
                                onClick={() => void runCheck(trimmedMint)}
                                disabled={!canCheck || !!preview}
                            >
                                {isChecking ? (
                                    <span className="inline-flex items-center gap-2">
                                        <Spinner className="h-4 w-4" /> Checking
                                    </span>
                                ) : (
                                    'Check mint'
                                )}
                            </Button>
                        </div>
                        {mintError ? <p className="text-xs text-destructive">{mintError}</p> : null}
                    </div>

                    {isChecking ? (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                            <Spinner className="h-4 w-4" /> Checking mint with stonk.fun…
                        </div>
                    ) : null}

                    {checkError ? (
                        <Alert variant="destructive">
                            <AlertTitle>Unable to check mint</AlertTitle>
                            <AlertDescription>{checkError}</AlertDescription>
                        </Alert>
                    ) : null}

                    {preview && contextMismatch ? (
                        <Alert variant="destructive">
                            <AlertTitle>Different asset</AlertTitle>
                            <AlertDescription>
                                This coin is launched against {contextMismatch.symbol ?? contextMismatch.assetId}, not{' '}
                                {context?.symbol}. Approving it will list it under{' '}
                                {contextMismatch.symbol ?? contextMismatch.assetId}.
                            </AlertDescription>
                        </Alert>
                    ) : null}

                    {preview ? <PreviewSummary preview={preview} /> : null}

                    {preview?.found ? (
                        <div className="space-y-1.5">
                            <Label htmlFor="launch-note">Note (optional)</Label>
                            <Input
                                id="launch-note"
                                value={note}
                                onChange={event => setNote(event.target.value)}
                                maxLength={LAUNCH_NOTE_MAX_LENGTH}
                                placeholder="Why this coin? Shown only in admin."
                                disabled={isSubmitting}
                            />
                        </div>
                    ) : null}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    {preview || checkError ? (
                        <Button
                            variant="outline"
                            onClick={() => {
                                resetChecked();
                                setMint('');
                            }}
                            disabled={isSubmitting || isChecking}
                        >
                            Check another mint
                        </Button>
                    ) : null}
                    <Button onClick={() => void onSubmit()} disabled={!canApprove}>
                        {isSubmitting ? 'Approving…' : preview?.approved ? 'Update approval' : 'Approve'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PreviewSummary({ preview }: { preview: LaunchpadMintPreview }) {
    const nowMs = Date.now();
    if (!preview.found || !preview.token) {
        return (
            <Alert variant="destructive">
                <AlertTitle>Not on stonk.fun</AlertTitle>
                <AlertDescription>
                    stonk.fun does not know <span className="font-mono text-xs">{preview.mint}</span>. Only coins
                    launched there can be approved.
                </AlertDescription>
            </Alert>
        );
    }
    const token = preview.token;
    const symbol = token.symbol ?? formatCompactMint(token.mint);
    const quote = preview.quote;

    return (
        <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-start gap-3">
                    <TokenAvatar imageUrl={token.imageUrl} label={symbol} className="h-12 w-12" />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="font-inter-semibold">{symbol}</span>
                            <Badge variant="info">stonk.fun</Badge>
                            <LaunchStateBadges
                                approved={preview.approved !== null}
                                synced={preview.synced}
                                isActive={preview.isActive}
                                meetsThreshold={preview.meetsThreshold}
                                status={token.status}
                            />
                        </div>
                        <div className="truncate text-sm text-muted-foreground">{token.name ?? '—'}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">{token.mint}</span>
                            <CopyButton value={token.mint} />
                            <a
                                href={stonkfunTokenUrl(token.mint)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:underline"
                            >
                                Open on stonk.fun ↗
                            </a>
                        </div>
                        {preview.approved ? (
                            <div className="mt-2 text-xs text-muted-foreground">
                                Approved {formatRelativeTime(preview.approved.approvedAt, nowMs)}
                                {preview.approved.note ? ` · “${preview.approved.note}”` : ''}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>

            {quote?.curated && quote.asset ? (
                <Alert>
                    <AlertTitle>Will show on the {quote.asset.symbol ?? quote.asset.assetId} page</AlertTitle>
                    <AlertDescription>
                        Quoted in {quote.symbol ?? formatCompactMint(quote.mint)} (
                        {quote.asset.name ?? quote.asset.assetId},{' '}
                        <span className="font-mono text-xs">{quote.asset.assetId}</span>). Once approved and synced it
                        appears in that asset&rsquo;s &ldquo;Launched on&rdquo; section.
                    </AlertDescription>
                </Alert>
            ) : quote ? (
                <Alert variant="destructive">
                    <AlertTitle>Quote token is not curated</AlertTitle>
                    <AlertDescription>
                        This coin is quoted in {quote.symbol ?? formatCompactMint(quote.mint)}, which is not one of our
                        assets, so there is no page for it to appear on. Approval is disabled.
                    </AlertDescription>
                </Alert>
            ) : null}

            {preview.warnings.length > 0 ? (
                <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    {preview.warnings.map(warning => (
                        <li key={warning}>{warning}</li>
                    ))}
                </ul>
            ) : null}

            <MarketSummary market={token.market} />

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <SummaryField label="Launchpad" value={token.launchpad ?? '—'} />
                <SummaryField label="Mode" value={token.mode ?? '—'} />
                <SummaryField
                    label="Graduated"
                    value={token.graduatedAt ? new Date(token.graduatedAt).toLocaleDateString() : '—'}
                />
            </div>
        </div>
    );
}
