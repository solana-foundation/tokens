'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import {
    CURATED_LIST_SLUGS,
    type CategoryRow,
    type UpdateCollectionMetaArgs,
    type UpdateCollectionMetaResult,
} from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Spinner } from '@tokens/ui/spinner';
import { Textarea } from '@tokens/ui/textarea';

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;

/** Membership for this list is Sanctum-driven, so only its display text is editable here. */
const AUTO_SYNCED_SLUGS = new Set<string>(['lsts']);

interface EditCategoriesDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function EditCategoriesDialog({ open, onOpenChange }: EditCategoriesDialogProps): React.JSX.Element {
    // Widen past the default six so `lsts` is editable too.
    const { data: categories } = useAdminQuery<CategoryRow[]>(
        'listCategories',
        open ? { slugs: CURATED_LIST_SLUGS } : 'skip',
    );

    const rows = categories ?? [];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit Front-Page Lists</DialogTitle>
                    <DialogDescription>
                        Update the public title and description for each curated list. This only changes display text —
                        list membership is managed from the asset table.
                    </DialogDescription>
                </DialogHeader>

                {categories === undefined ? (
                    <div className="flex items-center justify-center py-10">
                        <Spinner className="h-5 w-5" />
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex items-center justify-center py-10">
                        <p className="text-sm text-muted-foreground">No curated lists found.</p>
                    </div>
                ) : (
                    <div className="space-y-3 py-2">
                        {rows.map(row => (
                            <CategoryMetaRow key={row.id} row={row} />
                        ))}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CategoryMetaRow({ row }: { row: CategoryRow }): React.JSX.Element {
    // `updateCollectionMeta` invalidates the whole `['admin']` key space on success
    // (see useAdminMutation), so `listCategories` refetches for both this dialog and
    // the parent's "Front-page list" filter.
    const updateCollectionMeta = useAdminMutation<UpdateCollectionMetaResult, UpdateCollectionMetaArgs>(
        'updateCollectionMeta',
    );

    const [title, setTitle] = useState(row.name);
    const [description, setDescription] = useState(row.description ?? '');
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Re-seed from the server row whenever it changes (including after a save refetch).
    useEffect(() => {
        setTitle(row.name);
        setDescription(row.description ?? '');
    }, [row.name, row.description]);

    const trimmedTitle = title.trim();
    const titleError =
        trimmedTitle.length === 0
            ? 'Title is required.'
            : trimmedTitle.length > TITLE_MAX
              ? `Title must be ${TITLE_MAX} characters or fewer.`
              : null;
    const descriptionError =
        description.length > DESCRIPTION_MAX ? `Description must be ${DESCRIPTION_MAX} characters or fewer.` : null;

    const titleChanged = trimmedTitle !== row.name;
    const descriptionChanged = description !== (row.description ?? '');
    const isDirty = titleChanged || descriptionChanged;
    const isAutoSynced = AUTO_SYNCED_SLUGS.has(row.id);

    async function onSave() {
        if (!isDirty || titleError || descriptionError) return;
        setIsSubmitting(true);
        const toastId = toast.loading(`Saving ${row.id}…`);
        try {
            await updateCollectionMeta({
                slug: row.id,
                ...(titleChanged ? { title: trimmedTitle } : {}),
                // Empty string clears the description server-side.
                ...(descriptionChanged ? { description } : {}),
            });
            toast.success(`Saved ${row.id}`, { id: toastId });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <div className="space-y-3 rounded-[14px] border border-border-medium bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-inter-semibold uppercase tracking-[0.12em] text-muted-foreground">
                        {row.id}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {row.count} {row.count === 1 ? 'token' : 'tokens'}
                    </span>
                </div>
                <Button
                    size="sm"
                    onClick={onSave}
                    disabled={!isDirty || isSubmitting || !!titleError || !!descriptionError}
                >
                    {isSubmitting ? (
                        <span className="inline-flex items-center gap-2">
                            <Spinner className="h-4 w-4" /> Saving…
                        </span>
                    ) : (
                        'Save'
                    )}
                </Button>
            </div>

            {isAutoSynced ? (
                <p className="text-xs text-muted-foreground">
                    Membership is synced automatically from Sanctum — only the display text below is editable here.
                </p>
            ) : null}

            <div className="space-y-1.5">
                <Label htmlFor={`category-title-${row.id}`}>Title</Label>
                <Input
                    id={`category-title-${row.id}`}
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    disabled={isSubmitting}
                />
                {titleError ? <p className="text-xs text-destructive">{titleError}</p> : null}
            </div>

            <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                    <Label htmlFor={`category-description-${row.id}`}>Description</Label>
                    <span className="text-xs text-muted-foreground">
                        {description.length}/{DESCRIPTION_MAX}
                    </span>
                </div>
                <Textarea
                    id={`category-description-${row.id}`}
                    rows={2}
                    value={description}
                    onChange={event => setDescription(event.target.value)}
                    placeholder="Shown under the list heading on the front page."
                    disabled={isSubmitting}
                />
                {descriptionError ? <p className="text-xs text-destructive">{descriptionError}</p> : null}
            </div>
        </div>
    );
}
