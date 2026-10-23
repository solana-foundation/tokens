'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type { CanonicalSearchRow, MoveVariantToCanonicalResult, VariantEditor, VariantRef } from '@/lib/admin-types';
import { variantRefArgs } from '@/lib/admin-types';
import { chainLabel, isDerivedOrigin } from '@/lib/variant-ref';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';

interface MoveVariantDialogProps {
    variantRef: VariantRef | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function MoveVariantDialog({ variantRef, open, onOpenChange }: MoveVariantDialogProps): React.JSX.Element {
    const mint = variantRef?.address ?? null;
    const isSolana = variantRef === null || variantRef.chain === 'solana';
    const { data: editor } = useAdminQuery<VariantEditor>(
        'getVariantEditor',
        open && variantRef ? variantRefArgs(variantRef) : 'skip',
    );
    const { data: canonicalTargets } = useAdminQuery<CanonicalSearchRow[]>(
        'searchCanonicalAssets',
        open ? { query: '', limit: 100 } : 'skip',
    );
    const moveVariantToCanonical = useAdminMutation<MoveVariantToCanonicalResult>('moveVariantToCanonical');

    const [targetAssetId, setTargetAssetId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!open) {
            setTargetAssetId('');
            setIsSubmitting(false);
            return;
        }
        if (editor?.canonical.assetId) setTargetAssetId(editor.canonical.assetId);
    }, [editor?.canonical.assetId, open]);

    const filteredTargets = useMemo(
        () => (canonicalTargets ?? []).filter(target => target.assetId !== editor?.canonical.assetId),
        [canonicalTargets, editor?.canonical.assetId],
    );

    async function onSubmit() {
        if (!variantRef || !mint || !targetAssetId.trim() || !editor) return;
        setIsSubmitting(true);
        const toastId = toast.loading('Moving variant…');
        try {
            // `assetId` stays the legacy target name; the ref's owner travels as `fromAssetId`.
            const { assetId: fromAssetId, ...ref } = variantRefArgs(variantRef);
            const result = await moveVariantToCanonical({
                ...ref,
                fromAssetId,
                toAssetId: targetAssetId,
                assetId: targetAssetId,
            });
            if (result.moved) {
                toast.success(`Moved ${mint} from ${result.fromAssetId} to ${result.toAssetId}`, { id: toastId });
            } else {
                toast.message(`${mint} is already on ${result.toAssetId}`, { id: toastId });
            }
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Move Variant</DialogTitle>
                    <DialogDescription>
                        Reassign this {isSolana ? 'mint' : 'token'} from its current canonical asset to a new one.
                        {!isSolana && editor && isDerivedOrigin(editor.variant.origin)
                            ? ' This row was derived from CoinGecko; moving takes it over for admin so the daily sync does not re-derive it under the old asset.'
                            : ''}
                    </DialogDescription>
                </DialogHeader>

                {!editor ? (
                    <div className="flex items-center justify-center py-10">
                        <Button variant="outline" size="sm" disabled>
                            Loading…
                        </Button>
                    </div>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm">
                            <div>
                                <span className="font-inter-medium">Current canonical:</span> {editor.canonical.assetId}
                            </div>
                            <div>
                                <span className="font-inter-medium">Chain:</span>{' '}
                                {chainLabel(editor.variant.chain ?? 'solana')}
                            </div>
                            <div>
                                <span className="font-inter-medium">{isSolana ? 'Mint:' : 'Address:'}</span>{' '}
                                {editor.variant.address ?? editor.variant.mint}
                            </div>
                            <div>
                                <span className="font-inter-medium">Variant:</span> {editor.variant.variantId}
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="move-target">Destination canonical</Label>
                            <Select value={targetAssetId} onValueChange={setTargetAssetId}>
                                <SelectTrigger id="move-target">
                                    <SelectValue placeholder="Select canonical asset" />
                                </SelectTrigger>
                                <SelectContent>
                                    {filteredTargets.map(target => (
                                        <SelectItem key={target.assetId} value={target.assetId}>
                                            {target.symbol ?? target.assetId} — {target.name ?? target.assetId}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button
                        onClick={onSubmit}
                        disabled={
                            isSubmitting ||
                            !mint ||
                            !editor ||
                            !targetAssetId ||
                            targetAssetId === editor.canonical.assetId
                        }
                    >
                        {isSubmitting ? 'Moving…' : 'Move Variant'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
