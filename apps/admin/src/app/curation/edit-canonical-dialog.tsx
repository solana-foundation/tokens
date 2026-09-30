'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation, useAdminQuery } from '@/hooks/use-admin-api';
import type {
    AssetCategory,
    CanonicalEditor,
    CuratedCategorySlug,
    GenerateCanonicalLogoUploadUrlResult,
    UpdateCanonicalAssetResult,
} from '@/lib/admin-types';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Textarea } from '@tokens/ui/textarea';

type CategoryId = CuratedCategorySlug;

const COLLECTIONS: CategoryId[] = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'];

/** Mirrors `ASSET_ID_PATTERN` in cloudrun-admin (the server is the authority). */
const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

interface EditCanonicalDialogProps {
    assetId: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after a save that changed the asset id, with the old and new ids. */
    onRenamed?: (previousAssetId: string, nextAssetId: string) => void;
}

export function EditCanonicalDialog({
    assetId,
    open,
    onOpenChange,
    onRenamed,
}: EditCanonicalDialogProps): React.JSX.Element {
    const { data: editor } = useAdminQuery<CanonicalEditor>(
        'getCanonicalEditor',
        open && assetId ? { assetId } : 'skip',
    );
    const updateCanonicalAsset = useAdminMutation<UpdateCanonicalAssetResult>('updateCanonicalAsset');
    const generateCanonicalLogoUploadUrl = useAdminMutation<GenerateCanonicalLogoUploadUrlResult>(
        'generateCanonicalLogoUploadUrl',
    );

    const [nextAssetId, setNextAssetId] = useState('');
    const [category, setCategory] = useState<AssetCategory>('crypto');
    const [name, setName] = useState('');
    const [symbol, setSymbol] = useState('');
    const [coingeckoId, setCoingeckoId] = useState('');
    const [description, setDescription] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [uploadedLogoUrl, setUploadedLogoUrl] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [logoSource, setLogoSource] = useState<'upload' | 'url' | 'override' | 'variant' | 'none'>('none');
    const [clearImage, setClearImage] = useState(false);
    const [imageError, setImageError] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [aliases, setAliases] = useState('');
    const [collections, setCollections] = useState<CategoryId[]>([]);
    const [collectionInput, setCollectionInput] = useState<CategoryId | 'none'>('none');
    const [activity, setActivity] = useState<'active' | 'inactive'>('active');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!open || !editor) return;
        setNextAssetId(editor.asset.assetId);
        setCategory(editor.asset.category);
        setName(editor.asset.name ?? '');
        setSymbol(editor.asset.symbol ?? '');
        setCoingeckoId(editor.asset.coingeckoId ?? '');
        setDescription(editor.asset.description ?? '');
        setImageUrl(editor.asset.imageUrl ?? '');
        setUploadedLogoUrl(null);
        setPreviewUrl(editor.asset.resolvedImageUrl ?? null);
        setLogoSource(editor.asset.logoSource);
        setClearImage(false);
        setImageError(null);
        setIsUploading(false);
        setAliases((editor.aliases ?? []).join(', '));
        setCollections((editor.collections ?? []) as CategoryId[]);
        setActivity(editor.asset.isActive ? 'active' : 'inactive');
    }, [editor, open]);

    useEffect(() => {
        if (open) return;
        setIsSubmitting(false);
        setCollectionInput('none');
        setImageError(null);
        setIsUploading(false);
    }, [open]);

    async function onSelectFile(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0] ?? null;
        event.target.value = '';
        if (!file) return;

        const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
        if (!allowedTypes.has(file.type)) {
            setImageError('Unsupported file type. Use PNG, JPEG, WEBP, or SVG.');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            setImageError('File is too large. Max size is 2 MB.');
            return;
        }

        if (!assetId) {
            setImageError('Missing asset ID for logo upload.');
            return;
        }

        setImageError(null);
        setIsUploading(true);
        try {
            const { uploadUrl, publicUrl } = await generateCanonicalLogoUploadUrl({
                assetId,
                contentType: file.type,
            });
            const response = await fetch(uploadUrl, {
                method: 'PUT',
                headers: { 'Content-Type': file.type },
                body: file,
            });
            if (!response.ok) throw new Error(`Upload failed with ${response.status}`);

            setUploadedLogoUrl(publicUrl);
            setPreviewUrl(URL.createObjectURL(file));
            setLogoSource('upload');
            setClearImage(false);
        } catch (error) {
            setImageError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsUploading(false);
        }
    }

    const trimmedNextAssetId = nextAssetId.trim();
    const isRenaming = Boolean(editor) && trimmedNextAssetId !== editor?.asset.assetId;
    const assetIdError = !isRenaming
        ? null
        : !trimmedNextAssetId
          ? 'Asset ID is required.'
          : !ASSET_ID_PATTERN.test(trimmedNextAssetId)
            ? 'Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.'
            : null;

    async function onSubmit() {
        if (!assetId || assetIdError) return;
        setIsSubmitting(true);
        const toastId = toast.loading(isRenaming ? 'Renaming canonical asset…' : 'Saving canonical asset…');
        try {
            const result = await updateCanonicalAsset({
                assetId,
                ...(isRenaming ? { newAssetId: trimmedNextAssetId } : {}),
                category,
                name,
                symbol,
                coingeckoId,
                description,
                imageUrl: clearImage ? '' : (uploadedLogoUrl ?? imageUrl),
                clearImage,
                aliases: aliases
                    .split(',')
                    .map(alias => alias.trim())
                    .filter(Boolean),
                collections,
                isActive: activity === 'active',
            });
            if (result.updated) {
                toast.success(
                    result.assetId !== assetId ? `Renamed ${assetId} → ${result.assetId}` : `Saved ${assetId}`,
                    { id: toastId },
                );
            }
            if (result.assetId !== assetId) onRenamed?.(assetId, result.assetId);
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
        } finally {
            setIsSubmitting(false);
        }
    }

    const displayedPreviewUrl = clearImage ? (editor?.asset.fallbackImageUrl ?? null) : previewUrl;
    const displayedLogoSource = clearImage ? (editor?.asset.fallbackLogoSource ?? 'none') : logoSource;
    const sourceLabel =
        displayedLogoSource === 'upload'
            ? 'Uploaded'
            : displayedLogoSource === 'url'
              ? 'URL'
              : displayedLogoSource === 'override'
                ? 'Fallback override'
                : displayedLogoSource === 'variant'
                  ? 'Variant fallback'
                  : 'None';

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit Canonical Asset</DialogTitle>
                    <DialogDescription>
                        Update canonical metadata and curated list membership without changing child variants.
                    </DialogDescription>
                </DialogHeader>

                {!editor ? (
                    <div className="flex items-center justify-center py-10">
                        <Button variant="outline" size="sm" disabled>
                            Loading…
                        </Button>
                    </div>
                ) : (
                    <div className="grid gap-6 py-2 md:grid-cols-2">
                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-id">Asset ID</Label>
                                <Input
                                    id="asset-id"
                                    value={nextAssetId}
                                    onChange={event => setNextAssetId(event.target.value)}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    aria-invalid={assetIdError ? true : undefined}
                                />
                                {assetIdError ? <p className="text-sm text-destructive">{assetIdError}</p> : null}
                                {isRenaming && !assetIdError ? (
                                    <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                                        <p className="font-inter-medium">
                                            Renaming {editor.asset.assetId} to {trimmedNextAssetId}
                                        </p>
                                        <p className="text-muted-foreground">
                                            The id is rewritten across variants, lists, and market and stock
                                            caches. The old id keeps resolving to this asset.
                                        </p>
                                        {editor.asset.registryAssetId ? (
                                            <p className="text-muted-foreground">
                                                This asset comes from the static registry as{' '}
                                                <code>{editor.asset.registryAssetId}</code>. The nightly seed and
                                                the API follow the rename, but search, trending, and public pages
                                                keep showing the registry id until{' '}
                                                <code>packages/asset-registry</code> is updated in code.
                                            </p>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-category">Category</Label>
                                <Select value={category} onValueChange={value => setCategory(value as AssetCategory)}>
                                    <SelectTrigger id="asset-category">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="crypto">Crypto</SelectItem>
                                        <SelectItem value="stablecoin">Stablecoin</SelectItem>
                                        <SelectItem value="lst">LST</SelectItem>
                                        <SelectItem value="rwa">RWA</SelectItem>
                                        <SelectItem value="commodity">Commodity</SelectItem>
                                        <SelectItem value="equity">Equity</SelectItem>
                                        <SelectItem value="etf">ETF</SelectItem>
                                        <SelectItem value="index">Index</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-symbol">Canonical Symbol</Label>
                                <Input
                                    id="asset-symbol"
                                    value={symbol}
                                    onChange={event => setSymbol(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-name">Canonical Name</Label>
                                <Input id="asset-name" value={name} onChange={event => setName(event.target.value)} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-coingecko-id">CoinGecko ID</Label>
                                <Input
                                    id="asset-coingecko-id"
                                    value={coingeckoId}
                                    onChange={event => setCoingeckoId(event.target.value)}
                                />
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="space-y-3">
                                <Label>Canonical Logo</Label>
                                <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
                                    <Avatar className="h-14 w-14">
                                        {displayedPreviewUrl ? (
                                            <AvatarImage
                                                src={displayedPreviewUrl}
                                                alt={symbol || name || assetId || 'logo'}
                                            />
                                        ) : null}
                                        <AvatarFallback>{(symbol || name || '??').slice(0, 2)}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 space-y-1 text-sm">
                                        <div className="font-inter-medium">Current source: {sourceLabel}</div>
                                        <div className="truncate text-muted-foreground">
                                            {clearImage
                                                ? 'Explicit logo will be cleared on save.'
                                                : uploadedLogoUrl
                                                  ? 'Uploaded logo will be saved as the canonical image.'
                                                  : imageUrl
                                                    ? imageUrl
                                                    : (displayedPreviewUrl ?? 'No logo configured.')}
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="asset-image-upload">Upload logo</Label>
                                    <Input
                                        id="asset-image-upload"
                                        type="file"
                                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                                        onChange={onSelectFile}
                                        disabled={isUploading}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="asset-image-url">Logo URL</Label>
                                    <Input
                                        id="asset-image-url"
                                        value={imageUrl}
                                        onChange={event => {
                                            const value = event.target.value;
                                            setImageUrl(value);
                                            setClearImage(false);
                                            if (uploadedLogoUrl) return;
                                            if (value.trim()) {
                                                setPreviewUrl(value.trim());
                                                setLogoSource('url');
                                            } else {
                                                setPreviewUrl(editor?.asset.fallbackImageUrl ?? null);
                                                setLogoSource(editor?.asset.fallbackLogoSource ?? 'none');
                                            }
                                        }}
                                    />
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => {
                                            setClearImage(true);
                                            setImageUrl('');
                                            setUploadedLogoUrl(null);
                                            setPreviewUrl(editor?.asset.fallbackImageUrl ?? null);
                                            setLogoSource(editor?.asset.fallbackLogoSource ?? 'none');
                                            setImageError(null);
                                        }}
                                    >
                                        Clear explicit logo
                                    </Button>
                                </div>
                                {imageError ? <p className="text-sm text-destructive">{imageError}</p> : null}
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-description">Description</Label>
                                <Textarea
                                    id="asset-description"
                                    rows={4}
                                    value={description}
                                    onChange={event => setDescription(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-aliases">Custom Aliases</Label>
                                <Textarea
                                    id="asset-aliases"
                                    rows={3}
                                    value={aliases}
                                    onChange={event => setAliases(event.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="asset-status">Status</Label>
                                <Select
                                    value={activity}
                                    onValueChange={value => setActivity(value as 'active' | 'inactive')}
                                >
                                    <SelectTrigger id="asset-status">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="active">Active</SelectItem>
                                        <SelectItem value="inactive">Inactive</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1.5">
                                <Label>Collections</Label>
                                <div className="flex gap-2">
                                    <Select
                                        value={collectionInput}
                                        onValueChange={value => setCollectionInput(value as CategoryId | 'none')}
                                    >
                                        <SelectTrigger className="flex-1">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">None</SelectItem>
                                            {COLLECTIONS.map(collection => (
                                                <SelectItem key={collection} value={collection}>
                                                    {collection}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => {
                                            if (collectionInput === 'none') return;
                                            setCollections(current =>
                                                current.includes(collectionInput)
                                                    ? current
                                                    : [...current, collectionInput],
                                            );
                                        }}
                                    >
                                        Add
                                    </Button>
                                </div>
                                {collections.length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                        {collections.map(collection => (
                                            <Button
                                                key={collection}
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                    setCollections(current =>
                                                        current.filter(item => item !== collection),
                                                    )
                                                }
                                            >
                                                {collection} ×
                                            </Button>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button
                        onClick={onSubmit}
                        disabled={isSubmitting || isUploading || !assetId || !editor || Boolean(assetIdError)}
                    >
                        {isSubmitting ? 'Saving…' : isRenaming ? 'Rename and Save' : 'Save Canonical'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
