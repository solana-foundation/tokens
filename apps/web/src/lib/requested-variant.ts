import { CHAIN_KINDS, chainAddressKey, normalizeAddressForChain, type ChainKind } from '@tokens/asset-registry/chains';

/** The variant a URL asks for: `/{assetId}?{chain}={address}` (one query key per chain). */
export interface RequestedVariantRef {
    chain: ChainKind;
    address: string;
    /** `<chain>:<address>` */
    key: string;
}

type SearchParamsLike = Partial<Record<string, string | string[] | undefined>> | URLSearchParams | null | undefined;

export function firstString(value: string | string[] | undefined | null): string | undefined {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return typeof value === 'string' ? value : undefined;
}

function readParam(params: SearchParamsLike, key: string): string | undefined {
    if (!params) return undefined;
    if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
    return firstString(params[key]);
}

/**
 * First chain key (in `CHAIN_KINDS` order) carrying a valid address for that
 * chain wins; mismatched families (`?solana=0x…`, `?base=<base58>`) are
 * ignored. EVM addresses are lowercased.
 */
export function readRequestedVariant(params: SearchParamsLike): RequestedVariantRef | null {
    for (const chain of CHAIN_KINDS) {
        const raw = readParam(params, chain)?.trim();
        if (!raw) continue;
        const address = normalizeAddressForChain(chain, raw);
        if (!address) continue;
        return { chain, address, key: chainAddressKey(chain, address) };
    }
    return null;
}

/** A bare base58 path segment (`/{mint}`) is a Solana variant ref; a chainless `0x` path is not resolvable. */
export function requestedVariantFromPathName(name: string): RequestedVariantRef | null {
    const address = normalizeAddressForChain('solana', name);
    return address ? { chain: 'solana', address, key: chainAddressKey('solana', address) } : null;
}
