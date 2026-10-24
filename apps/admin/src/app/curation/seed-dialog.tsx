'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type { AdminSeedAssetResult, CuratedCategorySlug, PreviewMintResult } from '@/lib/admin-types';
import { Button } from '@tokens/ui/button';
import { Input } from '@tokens/ui/input';
import { Spinner } from '@tokens/ui/spinner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Badge } from '@solana/design-system/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';

type CategoryId = CuratedCategorySlug;

interface SeedDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function SeedDialog({ open, onOpenChange }: SeedDialogProps) {
    const adminSeedAsset = useAdminMutation<AdminSeedAssetResult>('adminSeedAsset');

    const [mint, setMint] = useState('');
    const [assetId, setAssetId] = useState('');
    const [slug, setSlug] = useState<CategoryId | 'none'>('none');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const trimmedMint = mint.trim();
    const isValidMint = MINT_REGEX.test(trimmedMint);

    // Reactive preview: looks up existing asset/variant/market data for the mint
    const { data: preview } = useAdminQuery<PreviewMintResult>(
        'previewMint',
        isValidMint ? { mint: trimmedMint } : 'skip',
    );

    // Auto-fill asset ID from preview when it changes
    useEffect(() => {
        if (preview?.assetId) {
            setAssetId(preview.assetId);
        }
    }, [preview?.assetId]);

    // Reset state when dialog opens/closes
    useEffect(() => {
        if (!open) {
            setMint('');
            setAssetId('');
            setSlug('none');
            setIsSubmitting(false);
        }
    }, [open]);

    async function onSubmit() {
        if (!isValidMint) return;

        setIsSubmitting(true);
        const toastId = toast.loading('Seeding token and fetching market data…');
        try {
            const res = await adminSeedAsset({
                mint: trimmedMint,
                ...(assetId.trim() ? { assetId: assetId.trim() } : {}),
                ...(slug !== 'none' ? { slug } : {}),
            });
            toast.success(`Seeded ${res.assetId}${res.slug ? ` → ${res.slug}` : ''}`, { id: toastId });
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), {
                id: toastId,
            });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Seed New Token</DialogTitle>
                    <DialogDescription>
                        Enter a Solana mint address. The system will fetch metadata from Birdeye, create the asset &amp;
                        variant records, and optionally add it to a front-page list. EVM tokens: create the canonical
                        first, then use Add Variant with the chain selected.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Mint Address */}
                    <div className="space-y-1.5">
                        <div className="text-sm font-inter-medium">Mint Address</div>
                        <Input
                            value={mint}
                            onChange={e => setMint(e.target.value)}
                            placeholder="Paste Solana mint (base58)"
                            disabled={isSubmitting}
                            autoFocus
                        />
                        {trimmedMint.length > 0 && !isValidMint && (
                            <p className="text-xs text-destructive">Not a valid base58 mint address</p>
                        )}
                    </div>

                    {/* Preview info (from DB lookup) */}
                    {preview && (
                        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
                            <div className="flex items-center gap-2">
                                {preview.exists ? (
                                    <Badge variant="info" dot>
                                        Existing variant
                                    </Badge>
                                ) : (
                                    <Badge variant="default" dot>
                                        New token
                                    </Badge>
                                )}
                                {preview.hasMarketData && (
                                    <Badge variant="success" dot>
                                        Has market data
                                    </Badge>
                                )}
                            </div>
                            {(preview.symbol || preview.name) && (
                                <p className="text-sm text-muted-foreground">
                                    {preview.symbol && <span className="font-inter-medium">{preview.symbol}</span>}
                                    {preview.symbol && preview.name && ' — '}
                                    {preview.name}
                                </p>
                            )}
                        </div>
                    )}

                    {/* Canonical Asset ID */}
                    <div className="space-y-1.5">
                        <div className="text-sm font-inter-medium">
                            Canonical Asset ID
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                                (auto-filled, editable)
                            </span>
                        </div>
                        <Input
                            value={assetId}
                            onChange={e => setAssetId(e.target.value)}
                            placeholder={isValidMint ? `solana-${trimmedMint}` : 'Enter mint first'}
                            disabled={isSubmitting || !isValidMint}
                        />
                    </div>

                    {/* Front-page collection */}
                    <div className="space-y-1.5">
                        <div className="text-sm font-inter-medium">
                            Add to Front Page List
                            <span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span>
                        </div>
                        <Select
                            value={slug}
                            onValueChange={val => setSlug(val as CategoryId | 'none')}
                            disabled={isSubmitting}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">None</SelectItem>
                                <SelectItem value="majors">Majors</SelectItem>
                                <SelectItem value="currencies">Currencies</SelectItem>
                                <SelectItem value="rwas">RWAs</SelectItem>
                                <SelectItem value="etfs">ETFs</SelectItem>
                                <SelectItem value="metals">Metals</SelectItem>
                                <SelectItem value="stocks">Stocks</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={onSubmit} disabled={isSubmitting || !isValidMint}>
                        {isSubmitting ? (
                            <span className="inline-flex items-center gap-2">
                                <Spinner className="h-4 w-4" /> Seeding…
                            </span>
                        ) : (
                            'Seed Token'
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
