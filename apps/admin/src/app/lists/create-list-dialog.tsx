'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type { AdminCreateTokenListResult, TokenListMutationErrorCode } from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';

/** Mirrors the server rule so the field can reject before the round trip. */
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,62}$/;

const ERROR_COPY: Partial<Record<TokenListMutationErrorCode, string>> = {
    slug_conflict: 'That slug is already in use.',
    reserved_slug: 'That slug is reserved.',
    invalid_slug: 'Slug must start with a letter and use 3–63 lowercase letters, numbers, or hyphens.',
    unknown_project: 'No project with that ID — check the owner project.',
};

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
}

interface CreateListDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called with the new slug so the page can immediately open the importer on it. */
    onCreated: (slug: string) => void;
}

/**
 * Create a community list on behalf of a project. The owner project is typed
 * in rather than picked — the admin service has no project directory — and
 * an unknown ID surfaces as a clear error from the FK, not a 500.
 */
export function CreateListDialog({ open, onOpenChange, onCreated }: CreateListDialogProps) {
    const createList = useAdminMutation<
        AdminCreateTokenListResult,
        { ownerProjectId: string; slug: string; name: string }
    >('adminCreateTokenList');

    const [ownerProjectId, setOwnerProjectId] = useState('');
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [slugTouched, setSlugTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (open) return;
        setOwnerProjectId('');
        setName('');
        setSlug('');
        setSlugTouched(false);
    }, [open]);

    const normalizedSlug = slug.trim().toLowerCase();
    const slugValid = SLUG_REGEX.test(normalizedSlug);
    const canSubmit = ownerProjectId.trim() !== '' && name.trim() !== '' && slugValid && !submitting;

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            const result = await createList({
                ownerProjectId: ownerProjectId.trim(),
                slug: normalizedSlug,
                name: name.trim(),
            });
            if (!result.ok) {
                toast.error(ERROR_COPY[result.error] ?? `Create failed: ${result.error}`);
                return;
            }
            toast.success(`Created ${result.value.slug}`);
            onOpenChange(false);
            onCreated(result.value.slug);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Create failed');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={next => !submitting && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[460px]">
                <DialogHeader>
                    <DialogTitle>New community list</DialogTitle>
                    <DialogDescription>
                        Creates the list under the given project, as if that project had called the v2 API. You can
                        import a CSV of members right after.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={event => void handleSubmit(event)} className="space-y-4 py-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="create-list-owner">Owner project ID</Label>
                        <Input
                            id="create-list-owner"
                            value={ownerProjectId}
                            onChange={event => setOwnerProjectId(event.target.value)}
                            placeholder="proj_…"
                            disabled={submitting}
                            className="font-mono"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="create-list-name">Name</Label>
                        <Input
                            id="create-list-name"
                            value={name}
                            onChange={event => {
                                setName(event.target.value);
                                if (!slugTouched) setSlug(slugify(event.target.value));
                            }}
                            placeholder="Ownership Core"
                            disabled={submitting}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="create-list-slug">Slug</Label>
                        <Input
                            id="create-list-slug"
                            value={slug}
                            onChange={event => {
                                setSlugTouched(true);
                                setSlug(event.target.value);
                            }}
                            placeholder="ownership-core"
                            disabled={submitting}
                            aria-invalid={slug !== '' && !slugValid}
                            className={`font-mono ${slug !== '' && !slugValid ? 'border-red-400' : ''}`}
                        />
                        <p className="text-xs text-muted-foreground">
                            Public read path: <code>/api/v2/lists/{normalizedSlug || '{slug}'}</code>. Renameable later.
                        </p>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="outline" disabled={!canSubmit}>
                            {submitting ? 'Creating…' : 'Create list'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
