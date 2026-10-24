'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type {
    StockVariantTier,
    TrustTier,
    UpdateVariantResult,
    VariantEditor,
    VariantKind,
    VariantRef,
} from '@/lib/admin-types';
import { variantRefArgs } from '@/lib/admin-types';
import { chainLabel, isDerivedOrigin } from '@/lib/variant-ref';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';

type StockVariantTierControlValue = StockVariantTier | 'none';

const KINDS: VariantKind[] = [
    'native',
    'wrapped',
    'bridged',
    'etf',
    'yield',
    'leveraged',
    'basket',
    'lst',
    'stablecoin',
    'tokenized_equity',
];
const TRUST_TIERS: TrustTier[] = ['tier1', 'tier2', 'tier3', 'experimental'];
const STOCK_VARIANT_TIERS: StockVariantTier[] = ['share_redeemable', 'cash_redeemable', 'not_redeemable'];

interface EditVariantDialogProps {
    variantRef: VariantRef | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function EditVariantDialog({ variantRef, open, onOpenChange }: EditVariantDialogProps): React.JSX.Element {
    const mint = variantRef?.address ?? null;
    const isSolana = variantRef === null || variantRef.chain === 'solana';
    const {
        data: editor,
        error: editorError,
        isLoading: isEditorLoading,
    } = useAdminQuery<VariantEditor | null>(
        'getVariantEditor',
        open && variantRef ? variantRefArgs(variantRef) : 'skip',
    );
    const updateVariant = useAdminMutation<UpdateVariantResult>('updateVariant');

    const [variantId, setVariantId] = useState('');
    const [kind, setKind] = useState<VariantKind>('wrapped');
    const [trustTier, setTrustTier] = useState<TrustTier>('tier3');
    const [stockVariantTier, setStockVariantTier] = useState<StockVariantTierControlValue>('none');
    const [label, setLabel] = useState('');
    const [issuer, setIssuer] = useState('');
    const [issuerUrl, setIssuerUrl] = useState('');
    const [tags, setTags] = useState('');
    const [activity, setActivity] = useState<'active' | 'inactive'>('active');
    const [marketSymbol, setMarketSymbol] = useState('');
    const [marketName, setMarketName] = useState('');
    const [marketLogoURI, setMarketLogoURI] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!open || !editor) return;
        setVariantId(editor.variant.variantId);
        setKind(editor.variant.kind);
        setTrustTier(editor.variant.trustTier);
        setStockVariantTier(
            editor.variant.stockVariantTier ??
                (editor.variant.kind === 'tokenized_equity' ? 'not_redeemable' : 'none'),
        );
        setLabel(editor.variant.label ?? '');
        setIssuer(editor.variant.issuer ?? '');
        setIssuerUrl(editor.variant.issuerUrl ?? '');
        setTags((editor.variant.tags ?? []).join(', '));
        setActivity(editor.variant.isActive ? 'active' : 'inactive');
        setMarketSymbol(editor.market?.symbol ?? '');
        setMarketName(editor.market?.name ?? '');
        setMarketLogoURI(editor.market?.logoURI ?? '');
    }, [editor, open]);

    useEffect(() => {
        if (open) return;
        setIsSubmitting(false);
    }, [open]);

    async function onSubmit() {
        if (!variantRef) return;
        setIsSubmitting(true);
        const toastId = toast.loading('Saving variant…');
        const showStockVariantTier = kind === 'tokenized_equity' || stockVariantTier !== 'none';
        try {
            const result = await updateVariant({
                ...variantRefArgs(variantRef),
                variantId,
                kind,
                trustTier,
                ...(showStockVariantTier
                    ? { stockVariantTier: stockVariantTier === 'none' ? null : stockVariantTier }
                    : {}),
                label,
                issuer,
                issuerUrl,
                tags: tags
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(Boolean),
                isActive: activity === 'active',
                marketSymbol,
                marketName,
                marketLogoURI,
            });
            if (result.updated) toast.success(`Saved ${result.mint}`, { id: toastId });
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit Variant</DialogTitle>
                    <DialogDescription>
                        Update variant metadata and display fields without changing canonical metadata.
                        {!isSolana && editor && isDerivedOrigin(editor.variant.origin)
                            ? ' This row was derived from CoinGecko; saving takes it over for admin so the daily sync stops rewriting it.'
                            : ''}
                        {!isSolana
                            ? ' Market symbol, name and logo on EVM rows are overwritten by the next Birdeye refresh.'
                            : ''}
                    </DialogDescription>
                </DialogHeader>

                {!editor ? (
                    <div className="flex items-center justify-center py-10 text-center text-sm text-muted-foreground">
                        {editorError ? (
                            <span className="text-destructive">Could not load this variant: {editorError.message}</span>
                        ) : isEditorLoading ? (
                            <Button variant="outline" size="sm" disabled>
                                Loading…
                            </Button>
                        ) : (
                            <span>
                                This variant could not be found
                                {variantRef ? ` (${chainLabel(variantRef.chain)} · ${variantRef.address})` : ''}. It may
                                have been removed or moved to another canonical asset.
                            </span>
                        )}
                    </div>
                ) : (
                    <div className="grid gap-6 py-2 md:grid-cols-2">
                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-canonical">Canonical</Label>
                                <Input
                                    id="variant-canonical"
                                    value={`${editor.canonical.symbol ?? editor.canonical.assetId} — ${editor.canonical.name ?? editor.canonical.assetId}`}
                                    disabled
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-chain">Chain</Label>
                                <Input
                                    id="variant-chain"
                                    value={`${chainLabel(editor.variant.chain ?? 'solana')}${editor.variant.origin && editor.variant.origin !== 'v1' ? ` · ${editor.variant.origin}` : ''}`}
                                    disabled
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-mint">{isSolana ? 'Mint' : 'Address'}</Label>
                                <Input id="variant-mint" value={editor.variant.address ?? editor.variant.mint} disabled />
                            </div>
                            {!isSolana ? (
                                <div className="space-y-1.5">
                                    <Label htmlFor="variant-decimals">Decimals</Label>
                                    <Input
                                        id="variant-decimals"
                                        value={editor.variant.decimals === null || editor.variant.decimals === undefined ? '—' : String(editor.variant.decimals)}
                                        disabled
                                    />
                                </div>
                            ) : null}
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-id">Variant ID</Label>
                                <Input
                                    id="variant-id"
                                    value={variantId}
                                    onChange={event => setVariantId(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-kind">Kind</Label>
                                <Select value={kind} onValueChange={value => setKind(value as VariantKind)}>
                                    <SelectTrigger id="variant-kind">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {KINDS.map(option => (
                                            <SelectItem key={option} value={option}>
                                                {option}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-tier">Trust Tier</Label>
                                <Select value={trustTier} onValueChange={value => setTrustTier(value as TrustTier)}>
                                    <SelectTrigger id="variant-tier">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TRUST_TIERS.map(option => (
                                            <SelectItem key={option} value={option}>
                                                {option}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            {(kind === 'tokenized_equity' || stockVariantTier !== 'none') ? (
                                <div className="space-y-1.5">
                                    <Label htmlFor="variant-stock-tier">Stock Variant Tier</Label>
                                    <Select
                                        value={stockVariantTier}
                                        onValueChange={value =>
                                            setStockVariantTier(value as StockVariantTierControlValue)
                                        }
                                    >
                                        <SelectTrigger id="variant-stock-tier">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">None</SelectItem>
                                            {STOCK_VARIANT_TIERS.map(option => (
                                                <SelectItem key={option} value={option}>
                                                    {option}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                            ) : null}
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-status">Status</Label>
                                <Select
                                    value={activity}
                                    onValueChange={value => setActivity(value as 'active' | 'inactive')}
                                >
                                    <SelectTrigger id="variant-status">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="active">Active</SelectItem>
                                        <SelectItem value="inactive">Inactive</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-label">Label</Label>
                                <Input
                                    id="variant-label"
                                    value={label}
                                    onChange={event => setLabel(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-issuer">Issuer</Label>
                                <Input
                                    id="variant-issuer"
                                    value={issuer}
                                    onChange={event => setIssuer(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-issuer-url">Issuer URL</Label>
                                <Input
                                    id="variant-issuer-url"
                                    value={issuerUrl}
                                    onChange={event => setIssuerUrl(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="variant-tags">Tags</Label>
                                <Input id="variant-tags" value={tags} onChange={event => setTags(event.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="market-symbol">Market Symbol</Label>
                                <Input
                                    id="market-symbol"
                                    value={marketSymbol}
                                    onChange={event => setMarketSymbol(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="market-name">Market Name</Label>
                                <Input
                                    id="market-name"
                                    value={marketName}
                                    onChange={event => setMarketName(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="market-logo-uri">Market Logo URI</Label>
                                <Input
                                    id="market-logo-uri"
                                    value={marketLogoURI}
                                    onChange={event => setMarketLogoURI(event.target.value)}
                                />
                            </div>
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={onSubmit} disabled={isSubmitting || !mint || !editor}>
                        {isSubmitting ? 'Saving…' : 'Save Variant'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
