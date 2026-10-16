import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';

import { getVariantByMint } from '@tokens/asset-registry';
import {
    CHAINS,
    EVM_CHAIN_KINDS,
    isChainKind,
    looksLikeEvmAddress,
    looksLikeSolanaAddress,
    normalizeAddressForChain,
} from '@tokens/asset-registry/chains';
import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import type { V2Variant, V2VariantsBatchResponse } from '@/lib/api-v2-types';
import { buildVariantHref } from '@/lib/coin-href';
import { firstString } from '@/lib/requested-variant';
import { loadV2VariantOwner } from '@/app/[name]/lib/load-v2-asset';

interface TokenPageProps {
    params: Promise<{ address: string }>;
    searchParams?: Promise<{ chain?: string | string[] | undefined }>;
}

type TokenRouteResolution =
    | { kind: 'redirect'; href: string; title: string }
    | { kind: 'choose'; variants: V2Variant[] }
    | { kind: 'not-found' };

function titleFor(name: string | null | undefined, symbol: string | null | undefined, fallback: string): string {
    const displayName = (name ?? '').trim() || fallback;
    const cleanSymbol = (symbol ?? '').trim();
    return cleanSymbol ? `${displayName} (${cleanSymbol}) | Tokens` : `${displayName} | Tokens`;
}

function variantTitle(variant: V2Variant, asset: { assetId: string; name: string | null; symbol: string | null }) {
    return titleFor(variant.name ?? variant.label ?? asset.name, variant.symbol ?? asset.symbol, asset.assetId);
}

/**
 * `/token/{address}` → the owning asset page with that variant selected.
 * Solana mints resolve through the static registry first, then the API; `0x`
 * addresses need a chain (`?chain=`), otherwise every EVM chain is tried and
 * an ambiguous hit asks the visitor to choose.
 */
const resolveTokenRoute = cache(async (rawAddress: string, rawChain: string | undefined) => {
    const address = rawAddress.trim();

    if (looksLikeSolanaAddress(address)) {
        const match = getVariantByMint(address);
        if (match) {
            if (match.asset.category === 'equity' && match.asset.variants.length === 1) {
                return {
                    kind: 'redirect',
                    href: buildVariantHref(match.asset.assetId, { chain: 'solana', address: undefined }),
                    title: titleFor(
                        match.variant.name ?? match.asset.name,
                        match.variant.symbol ?? match.asset.symbol,
                        match.asset.assetId,
                    ),
                } satisfies TokenRouteResolution;
            }
            const routeName = match.asset.coingeckoId ?? match.asset.assetId;
            return {
                kind: 'redirect',
                href: buildVariantHref(routeName, { chain: 'solana', address }),
                title: titleFor(
                    match.variant.name ?? match.asset.name,
                    match.variant.symbol ?? match.asset.symbol,
                    match.asset.assetId,
                ),
            } satisfies TokenRouteResolution;
        }

        const owner = await loadV2VariantOwner('solana', address);
        if (!owner?.asset?.assetId) return { kind: 'not-found' } satisfies TokenRouteResolution;
        return {
            kind: 'redirect',
            href: buildVariantHref(owner.asset.assetId, { chain: 'solana', address }),
            title: variantTitle(owner.variant, owner.asset),
        } satisfies TokenRouteResolution;
    }

    if (looksLikeEvmAddress(address)) {
        const chain = rawChain?.trim();
        if (chain) {
            const normalized = isChainKind(chain) ? normalizeAddressForChain(chain, address) : null;
            if (!isChainKind(chain) || !normalized) return { kind: 'not-found' } satisfies TokenRouteResolution;
            const owner = await loadV2VariantOwner(chain, normalized);
            if (!owner?.asset?.assetId) return { kind: 'not-found' } satisfies TokenRouteResolution;
            return {
                kind: 'redirect',
                href: buildVariantHref(owner.asset.assetId, { chain, address: normalized }),
                title: variantTitle(owner.variant, owner.asset),
            } satisfies TokenRouteResolution;
        }

        const lower = address.toLowerCase();
        const keys = EVM_CHAIN_KINDS.map(c => `${c}:${lower}`).join(',');
        const batch = await fetchApiAppJsonOrNull<V2VariantsBatchResponse>(
            `/api/v2/variants?keys=${encodeURIComponent(keys)}`,
            { next: { revalidate: 60 } },
        );
        const variants = (batch?.variants ?? []).filter(v => isChainKind(v.chain) && v.assetId);
        if (variants.length === 0) return { kind: 'not-found' } satisfies TokenRouteResolution;
        if (variants.length === 1) {
            const v = variants[0]!;
            return {
                kind: 'redirect',
                href: buildVariantHref(v.assetId, v),
                title: titleFor(v.name ?? v.label, v.symbol, v.assetId),
            } satisfies TokenRouteResolution;
        }
        return { kind: 'choose', variants } satisfies TokenRouteResolution;
    }

    return { kind: 'not-found' } satisfies TokenRouteResolution;
});

async function resolveFromProps({ params, searchParams }: TokenPageProps): Promise<TokenRouteResolution> {
    const [{ address }, resolvedSearchParams] = await Promise.all([params, searchParams]);
    return resolveTokenRoute(address, firstString(resolvedSearchParams?.chain));
}

export async function generateMetadata(props: TokenPageProps): Promise<Metadata> {
    const resolution = await resolveFromProps(props);
    if (resolution.kind === 'redirect') return { title: resolution.title };
    if (resolution.kind === 'choose') return { title: 'Choose a chain', robots: { index: false, follow: false } };
    return { title: 'Token Not Found' };
}

function variantChoiceLabel(variant: V2Variant): string {
    return `${CHAINS[variant.chain].label} — ${variant.name ?? variant.symbol ?? variant.address}`;
}

export default async function TokenPage(props: TokenPageProps) {
    const resolution = await resolveFromProps(props);
    if (resolution.kind === 'redirect') redirect(resolution.href);
    if (resolution.kind === 'not-found') notFound();

    return (
        <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-16">
            <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-semibold">Choose a chain</h1>
                <p className="text-muted-foreground text-sm">
                    This address belongs to a token on more than one chain. Pick the one you meant.
                </p>
            </div>
            <ul className="flex flex-col gap-2">
                {resolution.variants.map(variant => (
                    <li key={variant.key}>
                        <a
                            href={buildVariantHref(variant.assetId, variant)}
                            className="hover:bg-muted flex items-center justify-between rounded-lg border px-4 py-3 text-sm"
                        >
                            <span>{variantChoiceLabel(variant)}</span>
                            <span className="text-muted-foreground font-mono text-xs">{variant.address}</span>
                        </a>
                    </li>
                ))}
            </ul>
        </main>
    );
}
