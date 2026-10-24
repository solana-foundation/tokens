import { CHAINS, type ChainKind, normalizeAddressForChain } from '@tokens/asset-registry/chains';

import type { AdminVariantRow, VariantEditor, VariantOrigin, VariantRef } from './admin-types';

/** Chain of an admin variant row; rows from builds that predate multichain are Solana. */
export function rowChain(variant: Pick<AdminVariantRow, 'chain'>): ChainKind {
    return variant.chain ?? 'solana';
}

/** Mutation ref for a listed variant row. */
export function rowRef(variant: Pick<AdminVariantRow, 'assetId' | 'mint' | 'chain' | 'address'>): VariantRef {
    return { chain: rowChain(variant), address: variant.address ?? variant.mint, assetId: variant.assetId };
}

/** Mutation ref for the variant loaded in an editor dialog. */
export function editorRef(editor: NonNullable<VariantEditor>): VariantRef {
    return {
        chain: editor.variant.chain ?? 'solana',
        address: editor.variant.address ?? editor.variant.mint,
        assetId: editor.variant.assetId,
    };
}

export function isSolanaRef(ref: Pick<VariantRef, 'chain'>): boolean {
    return ref.chain === 'solana';
}

export function chainLabel(chain: ChainKind): string {
    return CHAINS[chain].label;
}

/** Stable React key / display key for a variant row. */
export function variantKey(ref: Pick<VariantRef, 'chain' | 'address'>): string {
    return `${ref.chain}:${ref.address}`;
}

/** Validation message for an address typed into a chain-aware form; null when it parses. */
export function addressError(chain: ChainKind, raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (normalizeAddressForChain(chain, trimmed) !== null) return null;
    return chain === 'solana'
        ? 'Not a valid Solana mint address.'
        : `Not a valid ${chainLabel(chain)} contract address (expected 0x + 40 hex characters).`;
}

/** Short human label for who owns a row (hidden for plain Solana rows). */
export function originLabel(origin: VariantOrigin | undefined): string | null {
    switch (origin) {
        case 'coingecko':
            return 'derived · CoinGecko';
        case 'config':
            return 'derived · native';
        case 'admin':
            return 'admin';
        default:
            return null;
    }
}

/** Derived rows are rewritten by the daily EVM sync unless admin takes them over. */
export function isDerivedOrigin(origin: VariantOrigin | undefined): boolean {
    return origin === 'coingecko' || origin === 'config';
}
