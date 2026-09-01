'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@tokens/ui/button';
import { Label } from '@tokens/ui/label';
import { Spinner } from '@tokens/ui/spinner';
import { Textarea } from '@tokens/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/app-ui/dialog';

import { parseMintsCsv } from './parse-mints-csv';

/** Rows per request — well under the API's 1000 cap and its per-call provider budget. */
const CHUNK_SIZE = 200;

type FailureCode = 'invalid_mint' | 'unknown_mint' | 'list_full' | string;

const FAILURE_COPY: Record<string, string> = {
    invalid_mint: 'not a valid mint address',
    unknown_mint: 'unknown to the registry, token index, and provider',
    list_full: 'list is at its member cap',
};

interface BatchResponse {
    added: Array<{ mint: string; verified: boolean }>;
    failed: Array<{ mint: string; error: FailureCode }>;
}

interface ImportSummary {
    added: number;
    verified: number;
    failed: BatchResponse['failed'];
}

interface ImportMembersDialogProps {
    slug: string | null;
    listName: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Authenticated fetch (the playground key-reveal proxy). */
    fetcher: (path: string, init?: { method?: string; body?: unknown }) => Promise<Response>;
    onImported: () => void;
}

/**
 * Bulk-add members from a CSV file or pasted text, through the same public
 * `POST /api/v2/lists/{slug}/members` partners script against. Rows are
 * previewed (ready / invalid / duplicate) before anything is sent, then posted
 * in chunks with progress. Row order becomes rank order for new members.
 */
export function ImportMembersDialog({
    slug,
    listName,
    open,
    onOpenChange,
    fetcher,
    onImported,
}: ImportMembersDialogProps) {
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
        if (!slug || parsed.rows.length === 0) return;
        setSummary(null);
        setProgress({ done: 0, total: parsed.rows.length });
        const acc: ImportSummary = { added: 0, verified: 0, failed: [] };
        try {
            for (let i = 0; i < parsed.rows.length; i += CHUNK_SIZE) {
                const chunk = parsed.rows.slice(i, i + CHUNK_SIZE);
                const res = await fetcher(`/api/v2/lists/${slug}/members`, {
                    method: 'POST',
                    body: {
                        members: chunk.map(row => ({ mint: row.mint, ...(row.note ? { note: row.note } : {}) })),
                    },
                });
                if (!res.ok) {
                    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                    throw new Error(body?.error?.message ?? `Import failed (HTTP ${res.status})`);
                }
                const body = (await res.json()) as BatchResponse;
                acc.added += body.added.length;
                acc.verified += body.added.filter(m => m.verified).length;
                acc.failed.push(...body.failed);
                setProgress({ done: Math.min(i + chunk.length, parsed.rows.length), total: parsed.rows.length });
            }
            setSummary(acc);
            onImported();
            if (acc.failed.length === 0) {
                toast.success(`Added ${acc.added} token${acc.added === 1 ? '' : 's'}`);
            } else {
                toast.warning(`Added ${acc.added}, ${acc.failed.length} skipped — see details`);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Import failed');
        } finally {
            setProgress(null);
        }
    }

    const canImport = Boolean(slug) && parsed.rows.length > 0 && !importing;

    return (
        <Dialog open={open} onOpenChange={next => !importing && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>Import tokens{listName ? ` into ${listName}` : ''}</DialogTitle>
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
                            className="font-berkeley-mono text-xs"
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
                                <span className="text-destructive">{parsed.invalid.length} invalid</span>
                            )}
                            {parsed.headerDetected && <span className="text-muted-foreground">header detected</span>}
                        </div>
                    )}

                    {parsed.invalid.length > 0 && (
                        <div className="max-h-28 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                            {parsed.invalid.slice(0, 20).map(item => (
                                <div key={item.line} className="font-berkeley-mono">
                                    line {item.line}: {item.value}
                                </div>
                            ))}
                            {parsed.invalid.length > 20 && <div>…and {parsed.invalid.length - 20} more</div>}
                        </div>
                    )}

                    {progress && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner size="sm" /> Importing {progress.done} / {progress.total}…
                        </div>
                    )}

                    {summary && (
                        <div className="space-y-2 rounded-lg border border-black/[0.08] bg-gray-50 p-3 text-sm dark:border-white/[0.08] dark:bg-zinc-900/60">
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
                                        <div key={item.mint} className="font-berkeley-mono">
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
