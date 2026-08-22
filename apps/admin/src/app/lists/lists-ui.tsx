'use client';

import { useState } from 'react';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type { TokenListAdminRow } from '@/lib/admin-types';

/**
 * Read-only oversight of community token lists (any status), with an
 * emergency archive. Partner self-service happens on the public v2 API;
 * this page exists so the team can take down an abusive list without SQL.
 */
export function ListsUi() {
    const { data: lists, isLoading, refetch } = useAdminQuery<TokenListAdminRow[]>('adminListTokenLists', {});
    const archiveList = useAdminMutation<{ archived: boolean }>('adminArchiveTokenList');
    const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
    const [busySlug, setBusySlug] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

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
            <div>
                <h1 className="text-xl font-inter-medium">Community token lists</h1>
                <p className="text-body-md text-muted-foreground">
                    Every list across projects, including drafts and archived. Archive is the emergency takedown —
                    it removes the list from discovery, reads, and composition.
                </p>
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
                                    <td className="p-3">{list.status}</td>
                                    <td className="p-3">{list.memberCount}</td>
                                    <td className="p-3">{new Date(list.updatedAt).toLocaleString()}</td>
                                    <td className="p-3 text-right">
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
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
