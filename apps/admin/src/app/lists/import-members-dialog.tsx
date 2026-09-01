'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type {
    AdminImportTokenListMembersResult,
    TokenListAdminRow,
    TokenListMutationErrorCode,
} from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Label } from '@tokens/ui/label';
import { Textarea } from '@tokens/ui/textarea';

import { parseMintsCsv } from './parse-mints-csv';

/** Rows per RPC call — under the server's batch cap and its Birdeye budget per call. */
const CHUNK_SIZE = 200;

const FAILURE_COPY: Record<TokenListMutationErrorCode, string> = {
    invalid_mint: 'not a valid mint address',
    unknown_mint: 'unknown to the registry, token index, and Birdeye',
    list_full: 'list is at its member cap',
    batch_too_large: 'batch too large',
    invalid_slug: 'invalid slug',
    reserved_slug: 'reserved slug',
    slug_conflict: 'slug conflict',
    unknown_project: 'unknown project',
    not_found: 'list not found',
    forbidden: 'forbidden',
};

interface ImportMembersDialogProps {
    list: TokenListAdminRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onImported: () => void;
}

interface ImportSummary {
    added: number;
    verified: number;
    failed: Array<{ mint: string; error: TokenListMutationErrorCode }>;
}

/**
 * Bulk-add members to a community list from a CSV file or pasted text. Rows
 * are previewed (valid / invalid / duplicate counts) before anything is sent,
 * then imported in chunks so a 3,000-row file neither times out the proxy nor
 * blows the per-call provider budget. Row order becomes rank order.
 */
export function ImportMembersDialog({ list, open, onOpenChange, onImported }: ImportMembersDialogProps) {
    const importMembers = useAdminMutation<
        AdminImportTokenListMembersResult,
        { slug: string; members: Array<{ mint: string; note?: string }> }
    >('adminImportTokenListMembers');

    const [text, setText] = useState('');
    const [fileName, setFileName] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) return;
        setText('');
        setFileName(null);
        setProgress(null);
        setSummary(null);
    }, [open]);

    const parsed = useMemo(() => parseMintsCsv(text), [text]);
    const importing = progress !== null;

    async function handleFile(file: File | undefined) {
        if (!file) return;
        setFileName(file.name);
        setText(await file.text());
        setSummary(null);
    }

    async function handleImport() {
        if (!list || parsed.rows.length === 0) return;
        setSummary(null);
        setProgress({ done: 0, total: parsed.rows.length });
        const acc: ImportSummary = { added: 0, verified: 0, failed: [] };
        try {
            for (let i = 0; i < parsed.rows.length; i += CHUNK_SIZE) {
                const chunk = parsed.rows.slice(i, i + CHUNK_SIZE);
                const result = await importMembers({
                    slug: list.slug,
                    members: chunk.map(row => ({ mint: row.mint, ...(row.note ? { note: row.note } : {}) })),
                });
                if (!result.ok) throw new Error(`Import failed: ${FAILURE_COPY[result.error] ?? result.error}`);
                acc.added += result.value.added.length;
                acc.verified += result.value.added.filter(m => m.verified).length;
                acc.failed.push(...result.value.failed);
                setProgress({ done: Math.min(i + chunk.length, parsed.rows.length), total: parsed.rows.length });
            }
            setSummary(acc);
            onImported();
            if (acc.failed.length === 0) {
                toast.success(`Added ${acc.added} token${acc.added === 1 ? '' : 's'} to ${list.slug}`);
            } else {
                toast.warning(`Added ${acc.added}, ${acc.failed.length} skipped — see details`);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Import failed');
        } finally {
            setProgress(null);
        }
    }

    const canImport = Boolean(list) && parsed.rows.length > 0 && !importing;

    return (
        <Dialog open={open} onOpenChange={next => !importing && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>Import tokens{list ? ` into ${list.name}` : ''}</DialogTitle>
                    <DialogDescription>
                        Upload a CSV or paste mints. A <code className="text-xs">mint</code> column (or{' '}
                        <code className="text-xs">address</code>) plus an optional <code className="text-xs">note</code>{' '}
                        column; headerless files and bare lists work too. Row order becomes rank order for new members.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    <div className="flex items-center gap-3">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv,.tsv,.txt,text/csv,text/plain"
                            className="hidden"
                            onChange={event => void handleFile(event.target.files?.[0])}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={importing}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            Choose file…
                        </Button>
                        <span className="truncate text-sm text-muted-foreground">
                            {fileName ?? 'No file chosen — or paste below'}
                        </span>
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="import-members-text">Rows</Label>
                        <Textarea
                            id="import-members-text"
                            value={text}
                            onChange={event => {
                                setText(event.target.value);
                                setSummary(null);
                            }}
                            placeholder={'mint,note\nEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,USD Coin'}
                            rows={8}
                            disabled={importing}
                            className="font-mono text-xs"
                        />
                    </div>

                    {text.trim() !== '' && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                            <span className="text-foreground">
                                <span className="font-inter-medium">{parsed.rows.length}</span> ready
                            </span>
                            {parsed.duplicates > 0 && (
                                <span className="text-muted-foreground">{parsed.duplicates} duplicate</span>
                            )}
                            {parsed.invalid.length > 0 && (
                                <span className="text-red-700">{parsed.invalid.length} invalid</span>
                            )}
                            {parsed.headerDetected && <span className="text-muted-foreground">header detected</span>}
                        </div>
                    )}

                    {parsed.invalid.length > 0 && (
                        <div className="max-h-28 overflow-y-auto rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
                            {parsed.invalid.slice(0, 20).map(item => (
                                <div key={item.line} className="font-mono">
                                    line {item.line}: {item.value}
                                </div>
                            ))}
                            {parsed.invalid.length > 20 && <div>…and {parsed.invalid.length - 20} more</div>}
                        </div>
                    )}

                    {progress && (
                        <div className="text-sm text-muted-foreground">
                            Importing {progress.done} / {progress.total}…
                        </div>
                    )}

                    {summary && (
                        <div className="space-y-2 rounded-md border border-border-medium bg-card p-3 text-sm">
                            <div>
                                Added <span className="font-inter-medium">{summary.added}</span> ({summary.verified}{' '}
                                verified, {summary.added - summary.verified} unverified)
                                {summary.failed.length > 0 && (
                                    <>
                                        , skipped <span className="font-inter-medium">{summary.failed.length}</span>
                                    </>
                                )}
                            </div>
                            {summary.failed.length > 0 && (
                                <div className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
                                    {summary.failed.map(item => (
                                        <div key={item.mint} className="font-mono">
                                            {item.mint} — {FAILURE_COPY[item.error] ?? item.error}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="ghost" disabled={importing} onClick={() => onOpenChange(false)}>
                        {summary ? 'Done' : 'Cancel'}
                    </Button>
                    <Button type="button" variant="outline" disabled={!canImport} onClick={() => void handleImport()}>
                        {importing
                            ? 'Importing…'
                            : `Import ${parsed.rows.length > 0 ? parsed.rows.length : ''} token${
                                  parsed.rows.length === 1 ? '' : 's'
                              }`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
