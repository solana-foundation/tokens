'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CHAIN_KINDS, CHAINS, type ChainKind } from '@tokens/asset-registry/chains';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type {
    AddCheckedVariantResult,
    CheckedVariantPreview,
    StockVariantTier,
    TrustTier,
} from '@/lib/admin-types';
import { addressError, chainLabel, isDerivedOrigin } from '@/lib/variant-ref';
import { Alert, AlertDescription, AlertTitle } from '@tokens/ui/alert';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Separator } from '@tokens/ui/separator';
import { Spinner } from '@tokens/ui/spinner';
import { Badge } from '@solana/design-system/badge';

type StockVariantTierControlValue = StockVariantTier | 'none';

type CanonicalVariantDefaults = {
    assetId: string;
    category: string;
    name?: string;
    symbol?: string;
    imageUrl?: string;
    collections?: string[];
};

const TRUST_TIERS: TrustTier[] = ['tier1', 'tier2', 'tier3', 'experimental'];
const STOCK_VARIANT_TIERS: StockVariantTier[] = ['share_redeemable', 'cash_redeemable', 'not_redeemable'];

interface AddVariantDialogProps {
    canonical: CanonicalVariantDefaults | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** Chain + address on a preview; backends that predate multichain only send `mint`. */
function previewChain(preview: CheckedVariantPreview): ChainKind {
    return preview.chain ?? preview.variantWrite.chain ?? 'solana';
}

function previewAddress(preview: CheckedVariantPreview): string {
    return preview.address ?? preview.variantWrite.address ?? preview.mint;
}

function addressNoun(chain: ChainKind): string {
    return chain === 'solana' ? 'mint' : 'contract address';
}

export function AddVariantDialog({ canonical, open, onOpenChange }: AddVariantDialogProps): React.JSX.Element {
    const checkVariantMintForCanonical = useAdminMutation<CheckedVariantPreview>('adminCheckVariantMintForCanonical');
    const addCheckedVariant = useAdminMutation<AddCheckedVariantResult>('adminAddCheckedVariant');

    const [chain, setChain] = useState<ChainKind>('solana');
    const [address, setAddress] = useState('');
    const [checkedPreview, setCheckedPreview] = useState<CheckedVariantPreview | null>(null);
    const [checkError, setCheckError] = useState<string | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [label, setLabel] = useState('');
    const [trustTier, setTrustTier] = useState<TrustTier>('tier3');
    const [stockVariantTier, setStockVariantTier] = useState<StockVariantTierControlValue>('none');
    const [tags, setTags] = useState('');
    const [decimals, setDecimals] = useState('');

    const trimmedAddress = address.trim();
    const hasAddress = trimmedAddress.length > 0;
    const mintError = useMemo(() => addressError(chain, trimmedAddress), [chain, trimmedAddress]);
    const isValidAddress = hasAddress && mintError === null;
    const canCheck = !!canonical && isValidAddress && !isChecking && !isSubmitting;

    // EVM rows need decimals even when Birdeye had nothing (the v2 row stores them).
    const previewDecimals = checkedPreview?.variantWrite.decimals ?? checkedPreview?.marketWrite?.decimals ?? null;
    const needsManualDecimals = !!checkedPreview && previewChain(checkedPreview) !== 'solana' && previewDecimals === null;
    const parsedDecimals = decimals.trim() === '' ? null : Number(decimals.trim());
    const decimalsValid =
        !needsManualDecimals ||
        (parsedDecimals !== null && Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 36);

    const blockingConflict = !!checkedPreview?.conflict && checkedPreview.conflict.type === 'other_canonical';
    // On Solana "already attached" is a hard stop (v1 keys on mint); on EVM the
    // same check means "adopt the existing row", which is allowed.
    const solanaAlreadyAttached =
        !!checkedPreview &&
        previewChain(checkedPreview) === 'solana' &&
        checkedPreview.conflict?.type === 'same_canonical';
    const canSubmit =
        !!checkedPreview && !blockingConflict && !solanaAlreadyAttached && decimalsValid && !isChecking && !isSubmitting;

    function resetCheckedState() {
        setCheckedPreview(null);
        setCheckError(null);
        setLabel('');
        setTrustTier('tier3');
        setStockVariantTier('none');
        setTags('');
        setDecimals('');
    }

    function onAddressChange(value: string) {
        setAddress(value);
        resetCheckedState();
    }

    function onChainChange(value: ChainKind) {
        setChain(value);
        resetCheckedState();
    }

    function onCheckAnotherMint() {
        setAddress('');
        resetCheckedState();
    }

    async function onCheckMint() {
        if (!canonical || !canCheck) return;
        setIsChecking(true);
        setCheckError(null);
        try {
            const result = await checkVariantMintForCanonical({
                assetId: canonical.assetId,
                chain,
                address: trimmedAddress,
                // Older backends read `mint` only.
                mint: trimmedAddress,
            });
            setCheckedPreview(result);
            setLabel(result.variantWrite.label ?? result.marketWrite?.symbol ?? '');
            setTrustTier(result.variantWrite.trustTier);
            setStockVariantTier(
                result.variantWrite.stockVariantTier ??
                    (canonical.category === 'equity' || result.variantWrite.kind === 'tokenized_equity'
                        ? 'not_redeemable'
                        : 'none'),
            );
            setTags(result.variantWrite.tags.join(', '));
            setDecimals('');
        } catch (error) {
            setCheckedPreview(null);
            setCheckError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsChecking(false);
        }
    }

    async function onSubmit() {
        if (!checkedPreview || !canSubmit) return;
        setIsSubmitting(true);
        const toastId = toast.loading('Adding variant…');
        try {
            const result = await addCheckedVariant({
                checkedPreview,
                overrides: {
                    label: label.trim() || null,
                    trustTier,
                    stockVariantTier:
                        canonical?.category === 'equity' || checkedPreview.variantWrite.kind === 'tokenized_equity'
                            ? stockVariantTier === 'none'
                                ? null
                                : stockVariantTier
                            : null,
                    tags: tags
                        .split(',')
                        .map(tag => tag.trim())
                        .filter(Boolean),
                    ...(needsManualDecimals && parsedDecimals !== null ? { decimals: parsedDecimals } : {}),
                },
            });
            const where = result.chain && result.chain !== 'solana' ? ` on ${chainLabel(result.chain)}` : '';
            const scheduled = result.scheduled.length > 0 ? ` Scheduled ${result.scheduled.join(', ')}.` : '';
            const adopted = result.adopted ? ' Took over the derived row.' : '';
            if (result.v2Synced === false) {
                toast.warning(
                    `Added ${result.mint} to ${result.assetId}${where}, but the v2 mirror did not run — tokens.xyz picks it up on the next 5-min sync.${scheduled}`,
                    { id: toastId },
                );
            } else {
                toast.success(
                    `Added ${result.mint} to ${result.assetId}${where}.${adopted}${scheduled} Live on tokens.xyz within ~1 min.`,
                    { id: toastId },
                );
            }
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    function onDialogOpenChange(nextOpen: boolean) {
        if (!nextOpen) {
            setChain('solana');
            setAddress('');
            resetCheckedState();
            setIsChecking(false);
            setIsSubmitting(false);
        }
        onOpenChange(nextOpen);
    }

    return (
        <Dialog open={open} onOpenChange={onDialogOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Add Variant</DialogTitle>
                    <DialogDescription>
                        Pick the chain, check the token, review Birdeye data, then add it to this canonical.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 py-2">
                    {canonical ? <CanonicalContextHeader canonical={canonical} /> : null}

                    <MintCheckForm
                        chain={chain}
                        address={address}
                        mintError={mintError}
                        isChecking={isChecking}
                        isSubmitting={isSubmitting}
                        canCheck={canCheck}
                        hasCheckedPreview={!!checkedPreview || !!checkError}
                        onChainChange={onChainChange}
                        onAddressChange={onAddressChange}
                        onCheckMint={onCheckMint}
                    />

                    {isChecking ? (
                        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                            <Spinner className="h-4 w-4" />
                            Checking {addressNoun(chain)} with Birdeye…
                        </div>
                    ) : null}

                    {checkError ? (
                        <Alert variant="destructive">
                            <AlertTitle>Unable to check {addressNoun(chain)}</AlertTitle>
                            <AlertDescription>{checkError}</AlertDescription>
                        </Alert>
                    ) : null}

                    {checkedPreview ? (
                        <div className="space-y-4">
                            <ConflictNotice preview={checkedPreview} />
                            <CheckedTokenSummary preview={checkedPreview} />
                            {checkedPreview.marketWrite ? (
                                <MarketSummary market={checkedPreview.marketWrite} />
                            ) : (
                                <Alert>
                                    <AlertTitle>No Birdeye data on {chainLabel(previewChain(checkedPreview))}</AlertTitle>
                                    <AlertDescription>
                                        The variant is added without a market snapshot; the EVM market refresh fills it
                                        in on its next pass (about hourly).
                                    </AlertDescription>
                                </Alert>
                            )}
                            <MinimalOverrides
                                label={label}
                                trustTier={trustTier}
                                stockVariantTier={stockVariantTier}
                                showStockVariantTier={
                                    canonical?.category === 'equity' ||
                                    checkedPreview.variantWrite.kind === 'tokenized_equity'
                                }
                                tags={tags}
                                decimals={decimals}
                                showDecimals={needsManualDecimals}
                                decimalsInvalid={needsManualDecimals && decimals.trim() !== '' && !decimalsValid}
                                disabled={isSubmitting}
                                onLabelChange={setLabel}
                                onTrustTierChange={setTrustTier}
                                onStockVariantTierChange={setStockVariantTier}
                                onTagsChange={setTags}
                                onDecimalsChange={setDecimals}
                            />
                            <DbWriteSummary
                                preview={checkedPreview}
                                label={label}
                                trustTier={trustTier}
                                stockVariantTier={stockVariantTier}
                                tags={tags}
                                decimals={needsManualDecimals ? parsedDecimals : previewDecimals}
                            />
                        </div>
                    ) : null}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onDialogOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    {checkedPreview || checkError ? (
                        <Button variant="outline" onClick={onCheckAnotherMint} disabled={isSubmitting || isChecking}>
                            Check another
                        </Button>
                    ) : null}
                    <Button onClick={onSubmit} disabled={!canSubmit}>
                        {isSubmitting
                            ? 'Adding…'
                            : checkedPreview?.conflict?.type === 'same_canonical' && !solanaAlreadyAttached
                              ? 'Adopt variant'
                              : 'Add variant'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CanonicalContextHeader({ canonical }: { canonical: CanonicalVariantDefaults }) {
    const collections = canonical.collections ?? [];
    return (
        <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-start gap-3">
                <Avatar className="h-10 w-10">
                    {canonical.imageUrl ? <AvatarImage src={canonical.imageUrl} alt={canonical.symbol ?? canonical.assetId} /> : null}
                    <AvatarFallback className="text-[10px]">
                        {(canonical.symbol ?? canonical.assetId).slice(0, 2)}
                    </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                    <div className="font-inter-semibold">{canonical.symbol ?? canonical.assetId}</div>
                    <div className="truncate text-sm text-muted-foreground">{canonical.name ?? canonical.assetId}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge variant="default">{canonical.category}</Badge>
                        <Badge variant="info">{canonical.assetId}</Badge>
                        {collections.length > 0 ? (
                            collections.map(collection => (
                                <Badge key={collection} variant="info">
                                    {collection}
                                </Badge>
                            ))
                        ) : (
                            <Badge variant="warning">No website lists</Badge>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function MintCheckForm({
    chain,
    address,
    mintError,
    isChecking,
    isSubmitting,
    canCheck,
    hasCheckedPreview,
    onChainChange,
    onAddressChange,
    onCheckMint,
}: {
    chain: ChainKind;
    address: string;
    mintError: string | null;
    isChecking: boolean;
    isSubmitting: boolean;
    canCheck: boolean;
    hasCheckedPreview: boolean;
    onChainChange: (value: ChainKind) => void;
    onAddressChange: (value: string) => void;
    onCheckMint: () => void;
}) {
    const locked = isChecking || isSubmitting || hasCheckedPreview;
    const isSolana = chain === 'solana';
    return (
        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <div className="space-y-1.5">
                <Label htmlFor="variant-chain">Chain</Label>
                <Select value={chain} onValueChange={value => onChainChange(value as ChainKind)} disabled={locked}>
                    <SelectTrigger id="variant-chain">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {CHAIN_KINDS.map(option => (
                            <SelectItem key={option} value={option}>
                                {CHAINS[option].label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor="variant-mint">{isSolana ? 'Mint' : 'Contract address'}</Label>
                <div className="flex gap-2">
                    <Input
                        id="variant-mint"
                        value={address}
                        onChange={event => onAddressChange(event.target.value)}
                        placeholder={isSolana ? 'Paste Solana mint' : `Paste ${CHAINS[chain].label} 0x address`}
                        disabled={locked}
                        autoFocus
                    />
                    <Button onClick={onCheckMint} disabled={!canCheck} className="shrink-0">
                        {isChecking ? (
                            <span className="inline-flex items-center gap-2">
                                <Spinner className="h-4 w-4" />
                                Checking
                            </span>
                        ) : isSolana ? (
                            'Check mint'
                        ) : (
                            'Check address'
                        )}
                    </Button>
                </div>
                {mintError ? <p className="text-xs text-destructive">{mintError}</p> : null}
            </div>
        </div>
    );
}

function ConflictNotice({ preview }: { preview: CheckedVariantPreview }) {
    const conflict = preview.conflict;
    if (!conflict) return null;
    const chain = previewChain(preview);
    const noun = addressNoun(chain);

    if (conflict.type === 'same_canonical') {
        if (chain === 'solana') {
            return (
                <Alert>
                    <AlertTitle>Already attached</AlertTitle>
                    <AlertDescription>
                        This mint is already attached to this canonical as {conflict.variantId}.
                    </AlertDescription>
                </Alert>
            );
        }
        const derived = isDerivedOrigin(conflict.origin);
        return (
            <Alert>
                <AlertTitle>{derived ? 'Derived row exists — adding adopts it' : 'Already attached'}</AlertTitle>
                <AlertDescription>
                    This {noun} is already on this canonical as {conflict.variantId}
                    {conflict.origin ? ` (${conflict.origin})` : ''}.{' '}
                    {derived
                        ? 'Adding takes the row over for admin: the daily CoinGecko sync will stop rewriting it, and your label, tier and tags win.'
                        : 'Adding updates the existing admin row in place.'}
                </AlertDescription>
            </Alert>
        );
    }

    if (conflict.type === 'shared_with') {
        return (
            <Alert>
                <AlertTitle>Address also backs other canonicals</AlertTitle>
                <AlertDescription>
                    On {chainLabel(chain)} this contract is already a variant of{' '}
                    {conflict.owners.map(owner => `${owner.assetId} (${owner.variantId}, ${owner.origin})`).join(', ')}.
                    That is allowed in v2 — an aggregate like <span className="font-mono text-xs">usd</span> shares
                    addresses with the coin&apos;s own asset — but double-check this is intended.
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <Alert variant="destructive">
            <AlertTitle>Mint belongs to another canonical</AlertTitle>
            <AlertDescription>
                Current canonical: {conflict.assetId}. Current variant: {conflict.variantId}. Use Move variant to reassign it.
            </AlertDescription>
        </Alert>
    );
}

function CheckedTokenSummary({ preview }: { preview: CheckedVariantPreview }) {
    const chain = previewChain(preview);
    const address = previewAddress(preview);
    const market = preview.marketWrite;
    const symbol = market?.symbol ?? preview.variantWrite.label ?? preview.variantWrite.variantId;
    const name = market?.name ?? preview.variantWrite.label ?? '—';
    const decimals = preview.variantWrite.decimals ?? market?.decimals ?? null;
    return (
        <div className="rounded-md border border-border bg-white p-3">
            <div className="flex items-start gap-3">
                <Avatar className="h-12 w-12">
                    {market?.logoURI ? <AvatarImage src={market.logoURI} alt={symbol} /> : null}
                    <AvatarFallback className="text-[10px]">{symbol.slice(0, 2)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="font-inter-semibold">{symbol}</div>
                        <Badge variant="info">{chainLabel(chain)}</Badge>
                        {market ? <Badge variant="success">Birdeye</Badge> : <Badge variant="warning">No market data</Badge>}
                    </div>
                    <div className="truncate text-sm text-muted-foreground">{name}</div>
                    <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-[1fr_auto]">
                        <div className="truncate">
                            <span className="font-inter-medium text-foreground">
                                {chain === 'solana' ? 'Mint:' : 'Address:'}
                            </span>{' '}
                            {address}
                        </div>
                        <CopyButton value={address} />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                        <span className="font-inter-medium text-foreground">Decimals:</span>{' '}
                        {decimals === null ? 'unknown — enter below' : decimals}
                        {preview.decimalsSource === 'coingecko' ? ' (from CoinGecko)' : ''}
                    </div>
                </div>
            </div>
        </div>
    );
}

function CopyButton({ value }: { value: string }) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void navigator.clipboard.writeText(value)}
        >
            Copy
        </Button>
    );
}

function MarketSummary({ market }: { market: NonNullable<CheckedVariantPreview['marketWrite']> }) {
    const fields = [
        ['Price', formatValue(market.price)],
        ['Liquidity', formatValue(market.liquidity)],
        ['Volume 24h', formatValue(market.volume24hUSD)],
        ['Market cap', formatValue(market.marketCap)],
        ['FDV', formatValue(market.fdv)],
        ['Holders', formatValue(market.holder)],
    ] as const;

    return (
        <div>
            <div className="mb-2 text-sm font-inter-semibold">Market summary</div>
            <div className="grid gap-2 sm:grid-cols-3">
                {fields.map(([label, value]) => (
                    <SummaryField key={label} label={label} value={value} />
                ))}
            </div>
        </div>
    );
}

function MinimalOverrides({
    label,
    trustTier,
    stockVariantTier,
    showStockVariantTier,
    tags,
    decimals,
    showDecimals,
    decimalsInvalid,
    disabled,
    onLabelChange,
    onTrustTierChange,
    onStockVariantTierChange,
    onTagsChange,
    onDecimalsChange,
}: {
    label: string;
    trustTier: TrustTier;
    stockVariantTier: StockVariantTierControlValue;
    showStockVariantTier: boolean;
    tags: string;
    decimals: string;
    showDecimals: boolean;
    decimalsInvalid: boolean;
    disabled: boolean;
    onLabelChange: (value: string) => void;
    onTrustTierChange: (value: TrustTier) => void;
    onStockVariantTierChange: (value: StockVariantTierControlValue) => void;
    onTagsChange: (value: string) => void;
    onDecimalsChange: (value: string) => void;
}) {
    return (
        <div className="space-y-3">
            <Separator />
            <div className="text-sm font-inter-semibold">Editable fields</div>
            <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <div className="space-y-1.5">
                    <Label htmlFor="variant-label">Label</Label>
                    <Input
                        id="variant-label"
                        value={label}
                        onChange={event => onLabelChange(event.target.value)}
                        disabled={disabled}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="variant-tier">Trust Tier</Label>
                    <Select value={trustTier} onValueChange={value => onTrustTierChange(value as TrustTier)} disabled={disabled}>
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
            </div>
            {showDecimals ? (
                <div className="space-y-1.5">
                    <Label htmlFor="variant-decimals">
                        Decimals <span className="text-xs font-normal text-muted-foreground">(required — no provider data)</span>
                    </Label>
                    <Input
                        id="variant-decimals"
                        inputMode="numeric"
                        value={decimals}
                        onChange={event => onDecimalsChange(event.target.value)}
                        disabled={disabled}
                        placeholder="18"
                    />
                    {decimalsInvalid ? (
                        <p className="text-xs text-destructive">Enter a whole number between 0 and 36.</p>
                    ) : null}
                </div>
            ) : null}
            {showStockVariantTier ? (
                <div className="space-y-1.5">
                    <Label htmlFor="variant-stock-tier">Stock Variant Tier</Label>
                    <Select
                        value={stockVariantTier}
                        onValueChange={value => onStockVariantTierChange(value as StockVariantTierControlValue)}
                        disabled={disabled}
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
                <Label htmlFor="variant-tags">Tags</Label>
                <Input
                    id="variant-tags"
                    value={tags}
                    onChange={event => onTagsChange(event.target.value)}
                    disabled={disabled}
                    placeholder="category:equity, curated:stocks"
                />
            </div>
        </div>
    );
}

function DbWriteSummary({
    preview,
    label,
    trustTier,
    stockVariantTier,
    tags,
    decimals,
}: {
    preview: CheckedVariantPreview;
    label: string;
    trustTier: TrustTier;
    stockVariantTier: StockVariantTierControlValue;
    tags: string;
    decimals: number | null;
}) {
    const chain = previewChain(preview);
    const isSolana = chain === 'solana';
    const market = preview.marketWrite;
    const variantFields = [
        ['assetId', preview.variantWrite.assetId],
        ['chain', chain],
        [isSolana ? 'mint' : 'address', previewAddress(preview)],
        ['variantId', preview.variantWrite.variantId],
        ['kind', preview.variantWrite.kind],
        ['trustTier', trustTier],
        ['stockVariantTier', stockVariantTier === 'none' ? '—' : stockVariantTier],
        ['label', label || '—'],
        ['tags', tags || '—'],
        ...(isSolana ? [] : [['decimals', decimals === null ? '—' : String(decimals)] as const]),
        ...(isSolana ? [] : [['origin', 'admin'] as const]),
    ] as const;
    const marketFields = market
        ? ([
              ['symbol', market.symbol],
              ['name', market.name],
              ['logoURI', market.logoURI ?? '—'],
              ['decimals', market.decimals === null ? '—' : String(market.decimals)],
              ['liquidity', formatValue(market.liquidity)],
              ['volume24hUSD', formatValue(market.volume24hUSD)],
              ['marketCap', formatValue(market.marketCap)],
              ['lastFetchedAt', new Date(market.lastFetchedAt).toLocaleString()],
          ] as const)
        : null;

    return (
        <div className="space-y-3">
            <Separator />
            <div>
                <div className="mb-2 text-sm font-inter-semibold">DB write summary</div>
                <div className="mb-2 text-xs font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {isSolana ? 'assetVariants (mirrored to v2 immediately)' : 'v2AssetVariants'}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                    {variantFields.map(([labelText, value]) => (
                        <SummaryField key={labelText} label={labelText} value={value} />
                    ))}
                </div>
            </div>
            <div>
                <div className="mb-2 text-xs font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {isSolana ? 'variantMarketsLatest' : 'v2VariantMarketsLatest'}
                </div>
                {marketFields ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                        {marketFields.map(([labelText, value]) => (
                            <SummaryField key={labelText} label={labelText} value={value} />
                        ))}
                    </div>
                ) : (
                    <div className="text-sm text-muted-foreground">No market row written (filled by the EVM refresh).</div>
                )}
            </div>
        </div>
    );
}

function SummaryField({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md border border-border-extra-light bg-white px-3 py-2">
            <div className="text-[11px] font-inter-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 truncate text-sm font-inter-medium text-foreground">{value}</div>
        </div>
    );
}

function formatValue(value: number | null): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString(undefined, { maximumFractionDigits: value >= 1 ? 2 : 8 });
}
