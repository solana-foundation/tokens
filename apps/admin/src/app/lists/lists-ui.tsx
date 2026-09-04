'use client';

import { useEffect, useState } from 'react';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type { TokenListAdminRow } from '@/lib/admin-types';

import { CreateListDialog } from './create-list-dialog';
import { ImportMembersDialog } from './import-members-dialog';

/**
 * Oversight of community token lists (any status) plus the team's build tools:
 * create a list on behalf of a project and bulk-import members from a CSV.
 * Partner self-service still happens on the public v2 API; archive remains the
 * emergency takedown for abusive lists.
 */
export function ListsUi() {
    const { data: lists, isLoading, refetch } = useAdminQuery<TokenListAdminRow[]>('adminListTokenLists', {});
    const archiveList = useAdminMutation<{ archived: boolean }>('adminArchiveTokenList');
    const unlockList = useAdminMutation<{ unlocked: boolean }>('adminUnlockTokenList');
    const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
    const [busySlug, setBusySlug] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [createOpen, setCreateOpen] = useState(false);
    const [importSlug, setImportSlug] = useState<string | null>(null);
    // Set by the create dialog; resolves to a row once the refetch lands, then opens the importer.
    const [pendingImportSlug, setPendingImportSlug] = useState<string | null>(null);

    const importList = lists?.find(list => list.slug === importSlug) ?? null;

    useEffect(() => {
        if (!pendingImportSlug || !lists?.some(list => list.slug === pendingImportSlug)) return;
        setImportSlug(pendingImportSlug);
        setPendingImportSlug(null);
    }, [pendingImportSlug, lists]);

    async function handleUnlock(slug: string) {
        setError(null);
        setBusySlug(slug);
        try {
            await unlockList({ slug });
            refetch();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusySlug(null);
        }
    }

    async function handleArchive(slug: string) {
        setError(null);
        setBusySlug(slug);
        try {
            await archiveList({ slug });
            setConfirmSlug(null);
            refetch();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusySlug(null);
        }
    }

    return (
        <div className="mx-auto max-w-5xl space-y-4 p-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-inter-medium">Community token lists</h1>
                    <p className="text-body-md text-muted-foreground">
                        Every list across projects, including drafts and archived. Import fills a list from a CSV;
                        archive is the emergency takedown — it removes the list from discovery, reads, and composition.
                    </p>
                </div>
                <button
                    type="button"
                    className="shrink-0 rounded-md border border-border-medium bg-card px-3 py-1.5 text-sm font-inter-medium"
                    onClick={() => setCreateOpen(true)}
                >
                    New list
                </button>
            </div>

            {error && (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-body-md text-red-800">{error}</div>
            )}

            {isLoading ? (
                <div className="text-body-md text-muted-foreground">Loading…</div>
            ) : !lists || lists.length === 0 ? (
                <div className="rounded-md border border-border-medium bg-card p-4 text-body-md text-muted-foreground">
                    No community lists yet.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-md border border-border-medium bg-card">
                    <table className="w-full text-left text-body-md">
                        <thead>
                            <tr className="border-b border-border-medium text-muted-foreground">
                                <th className="p-3 font-inter-medium">Slug</th>
                                <th className="p-3 font-inter-medium">Name</th>
                                <th className="p-3 font-inter-medium">Owner project</th>
                                <th className="p-3 font-inter-medium">Status</th>
                                <th className="p-3 font-inter-medium">Tokens</th>
                                <th className="p-3 font-inter-medium">Updated</th>
                                <th className="p-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {lists.map(list => (
                                <tr key={list.id} className="border-b border-border-medium last:border-b-0">
                                    <td className="p-3 font-mono text-sm">{list.slug}</td>
                                    <td className="p-3">{list.name}</td>
                                    <td className="p-3 font-mono text-sm">{list.ownerProjectId}</td>
                                    <td className="p-3">
                                        {list.status}
                                        {list.adminLockedAt !== null && (
                                            <span className="ml-2 rounded-sm bg-red-100 px-1.5 py-0.5 text-xs text-red-800">
                                                locked
                                            </span>
                                        )}
                                    </td>
                                    <td className="p-3">{list.memberCount}</td>
                                    <td className="p-3">{new Date(list.updatedAt).toLocaleString()}</td>
                                    <td className="p-3 text-right">
                                        <span className="inline-flex items-center gap-2">
                                            {list.adminLockedAt !== null && (
                                                <button
                                                    type="button"
                                                    className="rounded-md border border-border-medium px-2 py-1 text-sm disabled:opacity-50"
                                                    disabled={busySlug === list.slug}
                                                    onClick={() => void handleUnlock(list.slug)}
                                                >
                                                    {busySlug === list.slug ? 'Unlocking…' : 'Unlock'}
                                                </button>
                                            )}
                                            {list.status !== 'archived' && (
                                                <button
                                                    type="button"
                                                    className="rounded-md border border-border-medium px-2 py-1 text-sm"
                                                    onClick={() => setImportSlug(list.slug)}
                                                >
                                                    Import CSV
                                                </button>
                                            )}
                                            {list.status !== 'archived' &&
                                                (confirmSlug === list.slug ? (
                                                    <span className="inline-flex items-center gap-2">
                                                        <button
                                                            type="button"
                                                            className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-sm text-red-800 disabled:opacity-50"
                                                            disabled={busySlug === list.slug}
                                                            onClick={() => void handleArchive(list.slug)}
                                                        >
                                                            {busySlug === list.slug ? 'Archiving…' : 'Confirm archive'}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="rounded-md border border-border-medium px-2 py-1 text-sm"
                                                            onClick={() => setConfirmSlug(null)}
                                                        >
                                                            Cancel
                                                        </button>
                                                    </span>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="rounded-md border border-border-medium px-2 py-1 text-sm"
                                                        onClick={() => setConfirmSlug(list.slug)}
                                                    >
                                                        Archive
                                                    </button>
                                                ))}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <CreateListDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                onCreated={slug => {
                    setPendingImportSlug(slug);
                    refetch();
                }}
            />
            <ImportMembersDialog
                list={importList}
                open={importList !== null}
                onOpenChange={open => {
                    if (!open) setImportSlug(null);
                }}
                onImported={() => refetch()}
            />
        </div>
    );
}
