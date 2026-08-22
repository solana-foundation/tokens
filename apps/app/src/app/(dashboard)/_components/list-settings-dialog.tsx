'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Spinner } from '@tokens/ui/spinner';
import { CopyButton } from '@/components/app-ui/copy-button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/app-ui/dialog';

import { slugAvailabilityMessage, useSlugAvailability } from './use-slug-availability';

/** Shape this dialog needs from a `/api/v2/lists` summary row. */
export interface EditableList {
    slug: string;
    name: string;
    tokenCount: number;
}

interface ListSettingsDialogProps {
    list: EditableList | null;
    isOpen: boolean;
    onClose: () => void;
    /** Authenticated fetch used for the live slug-availability check. */
    fetcher: (path: string) => Promise<Response>;
    /** Sends the PATCH; resolves on success, rejects with a user-facing message. */
    onSave: (patch: { slug: string; name: string }) => Promise<void>;
    /** Permanently deletes the list; the caller owns navigation away from it. */
    onDelete: () => Promise<void>;
}

const FIELD_CLASS =
    'mt-1 rounded-lg bg-zinc-50 focus-visible:bg-white dark:focus-within:bg-zinc-950/50 dark:bg-zinc-900 focus-visible:ring-4 focus-visible:ring-offset-0 focus-visible:ring-zinc-400/20 dark:focus-visible:ring-zinc-600/20 focus-visible:border-zinc-400/60 dark:focus-visible:border-zinc-600/80 transition-all duration-150 ease-out';
const LABEL_CLASS = 'text-[11px] uppercase text-text-extra-low';

/** Server-side rule: `^[a-z][a-z0-9-]{2,62}$`, mirrored here for inline feedback. */
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,62}$/;

/**
 * List settings, modelled on the project settings dialog: editable metadata up
 * top, a danger zone below. The slug is editable — renaming is a clean cut, so
 * the field warns while the pending value differs from the live one.
 */
export function ListSettingsDialog({ list, isOpen, onClose, fetcher, onSave, onDelete }: ListSettingsDialogProps) {
    const [slug, setSlug] = useState(list?.slug ?? '');
    const [name, setName] = useState(list?.name ?? '');
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Reseed whenever the dialog opens on a (possibly different) list.
    useEffect(() => {
        if (!isOpen || !list) return;
        setSlug(list.slug);
        setName(list.name);
        setConfirmDelete(false);
    }, [isOpen, list]);

    // Derived before the null guard so the hook order stays stable across opens.
    const liveSlug = list?.slug ?? '';
    const nextSlug = slug.trim().toLowerCase();
    const slugChanged = nextSlug !== liveSlug;
    const availability = useSlugAvailability(slug, {
        enabled: isOpen && list !== null,
        ignore: liveSlug,
        fetcher,
    });

    if (!list) return <></>;

    const busy = isSaving || isDeleting;
    const slugValid = SLUG_REGEX.test(nextSlug);
    const dirty = slugChanged || name.trim() !== list.name;
    const availabilityMessage = slugAvailabilityMessage(availability);
    const slugBlocked = availability.state === 'unavailable';

    const handleSave = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!name.trim()) {
            toast.error('List name is required');
            return;
        }
        if (!slugValid) {
            toast.error('Slug must match ^[a-z][a-z0-9-]{2,62}$');
            return;
        }
        setIsSaving(true);
        try {
            await onSave({ slug: nextSlug, name: name.trim() });
            toast.success(slugChanged ? `List moved to /api/v2/lists/${nextSlug}` : 'List updated');
            onClose();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to update list');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);
        try {
            await onDelete();
            onClose();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to delete list');
        } finally {
            setIsDeleting(false);
            setConfirmDelete(false);
        }
    };

    return (
        <Dialog
            open={isOpen}
            onOpenChange={open => {
                if (!open && !busy) onClose();
            }}
        >
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>List settings</DialogTitle>
                    <DialogDescription>
                        Update how this list presents itself to consumers, or delete it outright.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSave}>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="list-settings-name" className={LABEL_CLASS}>
                                Name
                            </Label>
                            <Input
                                id="list-settings-name"
                                value={name}
                                onChange={event => setName(event.target.value)}
                                placeholder="Ownership Core"
                                maxLength={80}
                                required
                                disabled={busy}
                                className={FIELD_CLASS}
                            />
                        </div>

                        <div className="grid gap-2">
                            <Label htmlFor="list-settings-slug" className={LABEL_CLASS}>
                                Slug
                            </Label>
                            <Input
                                id="list-settings-slug"
                                value={slug}
                                onChange={event => setSlug(event.target.value)}
                                placeholder="ownership-core"
                                disabled={busy}
                                aria-invalid={slugBlocked}
                                className={`${FIELD_CLASS} font-berkeley-mono ${
                                    slugBlocked
                                        ? 'border-destructive text-destructive focus-visible:border-destructive focus-visible:ring-destructive/20'
                                        : ''
                                }`}
                            />
                            <div className="flex items-center justify-between gap-2">
                                <code className="truncate font-berkeley-mono text-xs text-muted-foreground">
                                    /api/v2/lists/{nextSlug || '…'}
                                </code>
                                <CopyButton
                                    textToCopy={`/api/v2/lists/${nextSlug}`}
                                    showText={false}
                                    ariaLabel="Copy list path"
                                    iconClassName="size-3.5"
                                />
                            </div>
                            {availabilityMessage && (
                                <p className={`text-xs ${slugBlocked ? 'text-destructive' : 'text-muted-foreground'}`}>
                                    {availabilityMessage}
                                </p>
                            )}
                            {slugChanged && availability.state === 'checking' && (
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <Spinner size="sm" /> Checking availability…
                                </div>
                            )}
                            {slugChanged && slugValid && !slugBlocked && (
                                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">
                                    Renaming is a clean cut —{' '}
                                    <code className="font-berkeley-mono">/api/v2/lists/{list.slug}</code> stops
                                    resolving the moment you save, and anyone can claim it after that.
                                </p>
                            )}
                        </div>

                    </div>

                    <DialogFooter className="flex !flex-col gap-2">
                        <Button
                            type="submit"
                            disabled={
                                busy ||
                                !name.trim() ||
                                !slugValid ||
                                !dirty ||
                                slugBlocked ||
                                availability.state === 'checking'
                            }
                            className="w-full"
                        >
                            {isSaving ? <Spinner /> : 'Save changes'}
                        </Button>
                        <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full">
                            Cancel
                        </Button>

                        {/* Danger zone */}
                        <div className="mt-4 w-full rounded-xl border border-red-500/20 bg-red-500/5 p-4">
                            <h3 className="mb-2 text-sm font-medium text-destructive">Danger Zone</h3>
                            <p className="mb-3 text-xs text-muted-foreground">
                                Deleting removes &quot;{list.name}&quot; and its {list.tokenCount} token
                                {list.tokenCount === 1 ? '' : 's'} for good — this cannot be undone. The slug{' '}
                                <code className="font-berkeley-mono">{list.slug}</code> goes back in the pool for anyone
                                to claim.
                            </p>
                            {confirmDelete ? (
                                <div className="flex gap-2">
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={() => void handleDelete()}
                                        disabled={busy}
                                        className="flex-1"
                                    >
                                        {isDeleting ? <Spinner /> : <span className="text-white">Confirm delete</span>}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => setConfirmDelete(false)}
                                        disabled={busy}
                                    >
                                        Cancel
                                    </Button>
                                </div>
                            ) : (
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => setConfirmDelete(true)}
                                    disabled={busy}
                                    className="w-full"
                                >
                                    <span className="text-white">Delete list</span>
                                </Button>
                            )}
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
