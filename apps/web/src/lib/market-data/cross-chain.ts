import 'server-only';

import { CHAIN_LIST, type ChainId } from './chains';
import { fetchChainTvl } from './defillama';
import { fetchNetworkDexSnapshot, type DexPool } from './geckoterminal';

/**
 * Combines protocol TVL (DefiLlama) with live DEX depth (GeckoTerminal) into a
 * single per-network view, plus a cross-network total.
 *
 * The two numbers answer different questions and are deliberately kept apart:
 * TVL is everything locked in the chain's protocols, while DEX liquidity is the
 * depth actually quotable right now in the sampled pools. Summing them would be
 * double counting.
 */

export interface ChainLiquidity {
    id: ChainId;
    label: string;
    nativeSymbol: string;
    explorerUrl: string;
    /** Null when the chain is not indexed by DefiLlama, not when TVL is zero. */
    tvlUsd: number | null;
    tvlTracked: boolean;
    /**
     * Depth across the sampled pools only (top 20 by 24h volume), not the
     * chain's total DEX liquidity. Comparable between chains, but a lower bound.
     */
    sampledDexLiquidityUsd: number | null;
    sampledDexVolume24hUsd: number | null;
    poolsSampled: number;
    /** Pools upstream reported with negative or unparseable reserves. */
    poolsWithInvalidLiquidity: number;
    topPools: DexPool[];
    /** True when the DEX API could not be reached for this network. */
    degraded: boolean;
}

export interface CrossChainLiquidity {
    chains: ChainLiquidity[];
    totals: {
        tvlUsd: number;
        sampledDexLiquidityUsd: number;
        sampledDexVolume24hUsd: number;
        /** Chains excluded from the TVL total because nobody tracks them. */
        chainsWithoutTvl: ChainId[];
        /** Chains whose DEX data failed to load this cycle. */
        degradedChains: ChainId[];
    };
    fetchedAt: number;
}

export async function getCrossChainLiquidity(): Promise<CrossChainLiquidity> {
    // GeckoTerminal serializes internally; awaiting the whole set here keeps the
    // DefiLlama lookup (cheap, cached) from being blocked behind that queue.
    const [tvls, snapshots] = await Promise.all([
        Promise.all(CHAIN_LIST.map(chain => fetchChainTvl(chain.defillamaChain))),
        Promise.all(CHAIN_LIST.map(chain => fetchNetworkDexSnapshot(chain))),
    ]);

    const chains: ChainLiquidity[] = CHAIN_LIST.map((chain, index) => {
        const tvlUsd = tvls[index] ?? null;
        const snapshot = snapshots[index] ?? null;

        return {
            id: chain.id,
            label: chain.label,
            nativeSymbol: chain.nativeSymbol,
            explorerUrl: chain.explorerUrl,
            tvlUsd,
            tvlTracked: chain.defillamaChain !== null,
            sampledDexLiquidityUsd: snapshot?.sampledLiquidityUsd ?? null,
            sampledDexVolume24hUsd: snapshot?.sampledVolume24hUsd ?? null,
            poolsSampled: snapshot?.poolCount ?? 0,
            poolsWithInvalidLiquidity: snapshot?.invalidLiquidityCount ?? 0,
            topPools: snapshot?.topPools ?? [],
            degraded: snapshot === null,
        };
    });

    const totals = chains.reduce(
        (acc, chain) => {
            acc.tvlUsd += chain.tvlUsd ?? 0;
            acc.sampledDexLiquidityUsd += chain.sampledDexLiquidityUsd ?? 0;
            acc.sampledDexVolume24hUsd += chain.sampledDexVolume24hUsd ?? 0;
            if (!chain.tvlTracked) acc.chainsWithoutTvl.push(chain.id);
            if (chain.degraded) acc.degradedChains.push(chain.id);
            return acc;
        },
        {
            tvlUsd: 0,
            sampledDexLiquidityUsd: 0,
            sampledDexVolume24hUsd: 0,
            chainsWithoutTvl: [] as ChainId[],
            degradedChains: [] as ChainId[],
        },
    );

    chains.sort((a, b) => (b.sampledDexLiquidityUsd ?? 0) - (a.sampledDexLiquidityUsd ?? 0));

    return { chains, totals, fetchedAt: Date.now() };
}
