'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useAdminMutation } from '@/hooks/use-admin-api';
import type {
    AssetCategory,
    CreateCanonicalAssetResult,
    CuratedCategorySlug,
    GenerateCanonicalLogoUploadUrlResult,
} from '@/lib/admin-types';
import { Avatar, AvatarFallback, AvatarImage } from '@tokens/ui/avatar';
import { Button } from '@tokens/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@tokens/ui/dialog';
import { Input } from '@tokens/ui/input';
import { Label } from '@tokens/ui/label';
import {
    ASSET_INDUSTRIES,
    ASSET_INDUSTRY_LABELS,
    ASSET_REGION_LABELS,
    ASSET_REGIONS,
    type AssetIndustry,
    type AssetRegion,
} from '@tokens/asset-registry/taxonomy';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';
import { Textarea } from '@tokens/ui/textarea';

type CategoryId = CuratedCategorySlug;

const COLLECTIONS: CategoryId[] = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'];

interface CreateCanonicalDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function CreateCanonicalDialog({ open, onOpenChange }: CreateCanonicalDialogProps): React.JSX.Element {
    const createCanonicalAsset = useAdminMutation<CreateCanonicalAssetResult>('createCanonicalAsset');
    const generateCanonicalLogoUploadUrl = useAdminMutation<GenerateCanonicalLogoUploadUrlResult>(
        'generateCanonicalLogoUploadUrl',
    );

    const [assetId, setAssetId] = useState('');
    const [category, setCategory] = useState<AssetCategory>('crypto');
    const [region, setRegion] = useState<AssetRegion | 'none'>('none');
    const [industry, setIndustry] = useState<AssetIndustry | 'none'>('none');
    const [name, setName] = useState('');
    const [symbol, setSymbol] = useState('');
    const [coingeckoId, setCoingeckoId] = useState('');
    const [description, setDescription] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [uploadedLogoUrl, setUploadedLogoUrl] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [logoSource, setLogoSource] = useState<'upload' | 'url' | 'none'>('none');
    const [imageError, setImageError] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [aliases, setAliases] = useState('');
    const [collectionInput, setCollectionInput] = useState<CategoryId | 'none'>('none');
    const [collections, setCollections] = useState<CategoryId[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (open) return;
        setAssetId('');
        setCategory('crypto');
        setRegion('none');
        setIndustry('none');
        setName('');
        setSymbol('');
        setCoingeckoId('');
        setDescription('');
        setImageUrl('');
        setUploadedLogoUrl(null);
        setPreviewUrl(null);
        setLogoSource('none');
        setImageError(null);
        setIsUploading(false);
        setAliases('');
        setCollectionInput('none');
        setCollections([]);
        setIsSubmitting(false);
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
        if (!assetId.trim()) {
            setImageError('Enter an Asset ID before uploading a logo.');
            return;
        }

        setImageError(null);
        setIsUploading(true);
        try {
            const { uploadUrl, publicUrl } = await generateCanonicalLogoUploadUrl({
                assetId: assetId.trim(),
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
        } catch (error) {
            setImageError(error instanceof Error ? error.message : String(error));
        } finally {
            setIsUploading(false);
        }
    }

    async function onSubmit() {
        if (!assetId.trim()) return;
        setIsSubmitting(true);
        const toastId = toast.loading('Creating canonical asset…');
        try {
            const result = await createCanonicalAsset({
                assetId,
                category,
                region: region === 'none' ? null : region,
                industry: industry === 'none' ? null : industry,
                name,
                symbol,
                coingeckoId,
                description,
                imageUrl: uploadedLogoUrl ?? imageUrl,
                aliases: aliases
                    .split(',')
                    .map(alias => alias.trim())
                    .filter(Boolean),
                collections,
            });
            toast.success(`Created canonical ${result.assetId}`, { id: toastId });
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
                    <DialogTitle>Create Canonical Asset</DialogTitle>
                    <DialogDescription>Create a new canonical asset before attaching variants to it.</DialogDescription>
                </DialogHeader>

                <div className="grid gap-6 py-2 md:grid-cols-2">
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="asset-id">Asset ID</Label>
                            <Input
                                id="asset-id"
                                value={assetId}
                                onChange={event => setAssetId(event.target.value)}
                                autoFocus
                            />
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
                            <Label htmlFor="asset-region">Region</Label>
                            <Select value={region} onValueChange={value => setRegion(value as AssetRegion | 'none')}>
                                <SelectTrigger id="asset-region">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">None</SelectItem>
                                    {ASSET_REGIONS.map(slug => (
                                        <SelectItem key={slug} value={slug}>
                                            {ASSET_REGION_LABELS[slug]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="asset-industry">Industry</Label>
                            <Select
                                value={industry}
                                onValueChange={value => setIndustry(value as AssetIndustry | 'none')}
                            >
                                <SelectTrigger id="asset-industry">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">None</SelectItem>
                                    {ASSET_INDUSTRIES.map(slug => (
                                        <SelectItem key={slug} value={slug}>
                                            {ASSET_INDUSTRY_LABELS[slug]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="asset-symbol">Canonical Symbol</Label>
                            <Input id="asset-symbol" value={symbol} onChange={event => setSymbol(event.target.value)} />
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
                                    {previewUrl ? (
                                        <AvatarImage src={previewUrl} alt={symbol || name || assetId || 'logo'} />
                                    ) : null}
                                    <AvatarFallback>{(symbol || name || '??').slice(0, 2)}</AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 space-y-1 text-sm">
                                    <div className="font-inter-medium">
                                        Current source:{' '}
                                        {logoSource === 'upload' ? 'Uploaded' : logoSource === 'url' ? 'URL' : 'None'}
                                    </div>
                                    <div className="truncate text-muted-foreground">
                                        {uploadedLogoUrl
                                            ? 'Uploaded logo will be used for this canonical.'
                                            : imageUrl || 'No logo configured yet.'}
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
                                        if (uploadedLogoUrl) return;
                                        if (value.trim()) {
                                            setPreviewUrl(value.trim());
                                            setLogoSource('url');
                                        } else {
                                            setPreviewUrl(null);
                                            setLogoSource('none');
                                        }
                                    }}
                                />
                            </div>
                            {imageError ? <p className="text-sm text-destructive">{imageError}</p> : null}
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="asset-description">Description</Label>
                            <Textarea
                                id="asset-description"
                                rows={5}
                                value={description}
                                onChange={event => setDescription(event.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="asset-aliases">Custom Aliases</Label>
                            <Textarea
                                id="asset-aliases"
                                rows={4}
                                value={aliases}
                                onChange={event => setAliases(event.target.value)}
                                placeholder="btc, xbt, wrapped-bitcoin"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Initial Collections</Label>
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
                                            current.includes(collectionInput) ? current : [...current, collectionInput],
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
                                                setCollections(current => current.filter(item => item !== collection))
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

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                        Cancel
                    </Button>
                    <Button onClick={onSubmit} disabled={isSubmitting || isUploading || !assetId.trim()}>
                        {isSubmitting ? 'Creating…' : 'Create Canonical'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
