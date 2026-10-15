'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type { AssetTagsImportApplyResult, AssetTagsImportMode, AssetTagsImportPreviewResult } from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Spinner } from '@tokens/ui/spinner';

interface ImportAssetTagsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

function IdList({ title, ids }: { title: string; ids: readonly string[] }): React.JSX.Element | null {
    if (ids.length === 0) return null;
    return (
        <details className="rounded-md border border-border bg-muted/30 p-3">
            <summary className="cursor-pointer text-sm font-inter-medium">
                {title} ({ids.length})
            </summary>
            <p className="mt-2 break-words font-mono text-xs text-muted-foreground">{ids.join(', ')}</p>
        </details>
    );
}

/**
 * Applies the bundled initial region/industry dataset (cloudrun-admin
 * `ASSET_TAGS_INITIAL`) to the curated stocks. Preview first, then apply.
 * `fill_empty` never touches an asset that already carries a tag.
 */
export function ImportAssetTagsDialog({ open, onOpenChange }: ImportAssetTagsDialogProps): React.JSX.Element {
    const [mode, setMode] = useState<AssetTagsImportMode>('fill_empty');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [applied, setApplied] = useState<AssetTagsImportApplyResult | null>(null);

    const {
        data: preview,
        isLoading,
        error,
        refetch,
    } = useAdminQuery<AssetTagsImportPreviewResult>('previewAssetTagsImport', open ? { mode } : 'skip');
    const applyAssetTagsImport = useAdminMutation<AssetTagsImportApplyResult>('applyAssetTagsImport');

    useEffect(() => {
        if (open) return;
        setMode('fill_empty');
        setIsSubmitting(false);
        setApplied(null);
    }, [open]);

    async function onApply() {
        if (!preview || preview.toApply.length === 0) return;
        setIsSubmitting(true);
        const toastId = toast.loading(`Tagging ${preview.toApply.length} assets…`);
        try {
            const result = await applyAssetTagsImport({ mode });
            setApplied(result);
            toast.success(`Tagged ${result.applied} assets`, { id: toastId });
            refetch();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    const summary = applied ?? preview;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Import Region/Industry Tags</DialogTitle>
                    <DialogDescription>
                        Applies the reviewed initial dataset for the curated stocks list. Each write sets{' '}
                        <code>admin_edited_at</code>; later edits in the asset dialog are never overwritten unless you
                        pick <em>Overwrite</em>.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="tags-import-mode">Mode</Label>
                        <Select
                            value={mode}
                            onValueChange={value => {
                                setApplied(null);
                                setMode(value as AssetTagsImportMode);
                            }}
                        >
                            <SelectTrigger id="tags-import-mode">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="fill_empty">Fill empty only (safe re-run)</SelectItem>
                                <SelectItem value="overwrite">Overwrite differing tags</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {isLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner className="h-4 w-4" /> Computing preview…
                        </div>
                    ) : error ? (
                        <p className="text-sm text-destructive">{error.message}</p>
                    ) : summary ? (
                        <div className="space-y-2">
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                <dt className="text-muted-foreground">Dataset rows</dt>
                                <dd>{summary.requested}</dd>
                                <dt className="text-muted-foreground">{applied ? 'Applied' : 'Will tag'}</dt>
                                <dd>{applied ? applied.applied : summary.toApply.length}</dd>
                                <dt className="text-muted-foreground">Already identical</dt>
                                <dd>{summary.unchanged.length}</dd>
                                <dt className="text-muted-foreground">Skipped (hand-tagged)</dt>
                                <dd>{summary.skippedAlreadyTagged.length}</dd>
                                <dt className="text-muted-foreground">Not found</dt>
                                <dd>{summary.unmatched.length}</dd>
                                <dt className="text-muted-foreground">Stocks still untagged after</dt>
                                <dd>{summary.untaggedStocks.length}</dd>
                            </dl>
                            <IdList title="Not found" ids={summary.unmatched} />
                            <IdList
                                title="Followed renames"
                                ids={summary.renamed.map(r => `${r.requested} → ${r.assetId}`)}
                            />
                            <IdList title="Still untagged (tag in the asset dialog)" ids={summary.untaggedStocks} />
                        </div>
                    ) : null}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Close
                    </Button>
                    <Button
                        onClick={onApply}
                        disabled={
                            isSubmitting || isLoading || !preview || preview.toApply.length === 0 || applied !== null
                        }
                    >
                        {isSubmitting ? <Spinner className="h-4 w-4" /> : null}
                        {applied ? 'Applied' : `Apply${preview ? ` (${preview.toApply.length})` : ''}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
