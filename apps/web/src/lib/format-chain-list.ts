import { CHAINS, CHAIN_KINDS, type ChainKind } from '@tokens/asset-registry/chains';

/** "Solana", "Solana and Base", "Solana, Ethereum and Base" (canonical chain order). */
export function formatChainList(chains: readonly ChainKind[]): string {
    const present = new Set(chains);
    const labels = CHAIN_KINDS.flatMap(chain => (present.has(chain) ? [CHAINS[chain].label] : []));
    if (labels.length === 0) return 'Solana';
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
