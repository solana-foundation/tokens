'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type {
    AdminVariantRow,
    AdvisoryStatus,
    ListVariantAdvisoriesResult,
    SetVariantAdvisoryArgs,
    SetVariantAdvisoryResult,
    VariantAdvisoryEventRow,
} from '@/lib/admin-types';
import {
    ADVISORY_REASON_MAX_LENGTH,
    ADVISORY_STATUS_OPTIONS,
    SYSTEM_ADVISORY_EDIT_WARNING,
    advisoryActorLabel,
    advisoryBadgeVariant,
    advisorySetToastMessage,
    advisoryStatusDescription,
    describeAdvisoryEvent,
    formatRelativeTime,
    isSystemActor,
    isSystemManagedAdvisory,
    validateAdvisoryReason,
    validateAdvisoryUrl,
} from '@/lib/advisory-labels';
import { Button } from '@tokens/ui/button';
import { Checkbox } from '@tokens/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Spinner } from '@tokens/ui/spinner';
import { Textarea } from '@tokens/ui/textarea';
import { Badge } from '@solana/design-system/badge';

const EVENTS_LIMIT = 5;

interface SetAdvisoryDialogProps {
    /** Snapshot of the variant row the dialog was opened from (null when closed). */
    variant: AdminVariantRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SetAdvisoryDialog({ variant, open, onOpenChange }: SetAdvisoryDialogProps): React.JSX.Element {
    const mint = variant?.mint ?? null;
    const existing = variant?.advisory ?? null;
    const symbol = variant?.symbol ?? variant?.label ?? variant?.variantId ?? '';
    const showReactivate = variant !== null && !variant.isActive;
    // Any admin save stamps source='admin' and detaches the row from the depeg reconciler.
    const isSystemManaged = isSystemManagedAdvisory(existing);

    const { data: history, error: historyError } = useAdminQuery<ListVariantAdvisoriesResult>(
        'listVariantAdvisories',
        open && mint ? { mint, eventsLimit: EVENTS_LIMIT } : 'skip',
    );
    const setVariantAdvisory = useAdminMutation<SetVariantAdvisoryResult, SetVariantAdvisoryArgs>('setVariantAdvisory');

    const [status, setStatus] = useState<AdvisoryStatus>('caution');
    const [reason, setReason] = useState('');
    const [url, setUrl] = useState('');
    const [reactivate, setReactivate] = useState(true);
    const [attemptedSubmit, setAttemptedSubmit] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [now, setNow] = useState(0);

    // Prefill from the existing advisory when editing; reset when the dialog
    // closes or is opened for a different mint. Deps are primitives so a
    // background refetch of the variant list does not clobber in-progress edits.
    const existingStatus = existing?.status ?? null;
    const existingReason = existing?.reason ?? '';
    const existingUrl = existing?.url ?? '';
    useEffect(() => {
        if (!open) {
            setAttemptedSubmit(false);
            setIsSubmitting(false);
            return;
        }
        setStatus(existingStatus ?? 'caution');
        setReason(existingReason);
        setUrl(existingUrl);
        setReactivate(true);
        setNow(Date.now());
    }, [open, mint, existingStatus, existingReason, existingUrl]);

    const reasonCheck = validateAdvisoryReason(reason);
    const urlCheck = validateAdvisoryUrl(url);
    const showReasonError = attemptedSubmit && !reasonCheck.ok;
    const showUrlError = !urlCheck.ok && (attemptedSubmit || url.trim().length > 0);

    async function onSubmit() {
        if (!variant) return;
        setAttemptedSubmit(true);
        if (!reasonCheck.ok || !urlCheck.ok) return;

        setIsSubmitting(true);
        const toastId = toast.loading(`Saving advisory for ${symbol}…`);
        try {
            const result = await setVariantAdvisory({
                mint: variant.mint,
                status,
                reason: reasonCheck.reason,
                url: urlCheck.url,
                ...(showReactivate ? { activateVariant: reactivate } : {}),
            });
            toast.success(advisorySetToastMessage({ symbol, status: result.status, reactivated: result.reactivated }), {
                id: toastId,
            });
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
                    <DialogTitle>{existing ? 'Edit Advisory' : 'Set Advisory'}</DialogTitle>
                    <DialogDescription>
                        Flag this mint across the API, web app, and lists without deactivating it. Changes propagate
                        within about a minute and are recorded in the audit log below.
                    </DialogDescription>
                </DialogHeader>

                {isSystemManaged ? (
                    <div
                        role="note"
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
                    >
                        {SYSTEM_ADVISORY_EDIT_WARNING}
                    </div>
                ) : null}

                {!variant ? (
                    <div className="flex items-center justify-center py-10">
                        <Button variant="outline" size="sm" disabled>
                            Loading…
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="advisory-variant">Variant</Label>
                                <Input
                                    id="advisory-variant"
                                    value={`${symbol} — ${variant.variantId}${variant.isActive ? '' : ' (inactive)'}`}
                                    disabled
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="advisory-mint">Mint</Label>
                                <Input id="advisory-mint" value={variant.mint} disabled />
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="advisory-status">Status</Label>
                            <Select value={status} onValueChange={value => setStatus(value as AdvisoryStatus)}>
                                <SelectTrigger id="advisory-status">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {ADVISORY_STATUS_OPTIONS.map(option => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">{advisoryStatusDescription(status)}</p>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <Label htmlFor="advisory-reason">Reason</Label>
                                <span
                                    className={`text-xs tabular-nums ${
                                        reason.trim().length > ADVISORY_REASON_MAX_LENGTH
                                            ? 'text-destructive'
                                            : 'text-muted-foreground'
                                    }`}
                                >
                                    {reason.trim().length}/{ADVISORY_REASON_MAX_LENGTH}
                                </span>
                            </div>
                            <Textarea
                                id="advisory-reason"
                                rows={3}
                                value={reason}
                                onChange={event => setReason(event.target.value)}
                                placeholder="What happened and what we recommend, e.g. “Issuer treasury exploited; Sunrise pulled the market. Do not trade.”"
                                aria-invalid={showReasonError || undefined}
                            />
                            {showReasonError && !reasonCheck.ok ? (
                                <p className="text-xs text-destructive">{reasonCheck.error}</p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Shown verbatim to API consumers and on the token page. State what is known and the
                                    recommendation; do not speculate on cause or recoverability.
                                </p>
                            )}
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="advisory-url">Source URL (optional)</Label>
                            <Input
                                id="advisory-url"
                                inputMode="url"
                                value={url}
                                onChange={event => setUrl(event.target.value)}
                                placeholder="https://…"
                                aria-invalid={showUrlError || undefined}
                            />
                            {showUrlError && !urlCheck.ok ? (
                                <p className="text-xs text-destructive">{urlCheck.error}</p>
                            ) : null}
                        </div>

                        {showReactivate ? (
                            <label className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                                <Checkbox
                                    checked={reactivate}
                                    onCheckedChange={value => setReactivate(value === true)}
                                    aria-label="Also re-activate this variant"
                                    className="mt-0.5"
                                />
                                <span className="space-y-0.5 text-sm">
                                    <span className="block font-inter-medium">Also re-activate this variant</span>
                                    <span className="block text-xs text-muted-foreground">
                                        The variant is currently inactive (hidden everywhere). Re-activating it with an
                                        advisory makes the warning visible instead of a silent removal. Done in the same
                                        transaction.
                                    </span>
                                </span>
                            </label>
                        ) : null}

                        <AdvisoryHistory events={history?.events} error={historyError} now={now} />
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={onSubmit} disabled={isSubmitting || !variant}>
                        {isSubmitting
                            ? 'Saving…'
                            : !existing
                              ? 'Set Advisory'
                              : isSystemManaged
                                ? 'Save and detach'
                                : 'Save Advisory'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AdvisoryHistory({
    events,
    error,
    now,
}: {
    events: VariantAdvisoryEventRow[] | undefined;
    error: Error | null;
    now: number;
}): React.JSX.Element {
    return (
        <section className="space-y-2">
            <div className="text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Recent events
            </div>
            {error ? (
                <p className="text-xs text-destructive">Could not load history: {error.message}</p>
            ) : events === undefined ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Spinner className="h-4 w-4" /> Loading history…
                </div>
            ) : events.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">No advisory events for this mint yet.</p>
            ) : (
                <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {events.map(event => (
                        <li key={event.id} className="space-y-1 px-3 py-2 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="font-inter-medium">{describeAdvisoryEvent(event)}</span>
                                {event.status ? (
                                    <Badge variant={advisoryBadgeVariant(event.status)}>{event.status}</Badge>
                                ) : null}
                                {isSystemActor(event) ? <Badge variant="info">auto</Badge> : null}
                                {event.reactivatedVariant ? <Badge variant="info">re-activated</Badge> : null}
                                <span
                                    className="ml-auto text-xs text-muted-foreground"
                                    title={new Date(event.createdAt).toLocaleString()}
                                >
                                    {formatRelativeTime(event.createdAt, now)}
                                </span>
                            </div>
                            <div className="truncate text-xs text-muted-foreground" title={event.reason ?? undefined}>
                                {advisoryActorLabel(event)}
                                {event.reason ? ` — ${event.reason}` : ''}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
