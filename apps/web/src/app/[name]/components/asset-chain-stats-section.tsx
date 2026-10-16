import Link from 'next/link';

import { CHAINS, CHAIN_KINDS, type ChainKind } from '@tokens/asset-registry/chains';

import { formatCount } from '@/app/token/[address]/lib/format';
import type { V2ChainStats } from '@/lib/api-v2-types';
import { buildVariantHref } from '@/lib/coin-href';
import { formatLargeNumber } from '@/lib/format';

interface AssetChainStatsSectionProps {
    assetId: string;
    displayName: string;
    chains: readonly ChainKind[];
    chainStats: Partial<Record<ChainKind, V2ChainStats>>;
    /** The chain's primary variant, when the API picked one; links the row to its variant view. */
    primaryVariantByChain: Partial<Record<ChainKind, { address: string; symbol: string }>>;
}

/**
 * Canonical view of a multichain asset: one row per chain with the on-chain
 * liquidity, 24h volume, 24h trades and variant count from `chainStats` (computed from the
 * unfiltered variant set, so the numbers match the headline aggregate).
 */
export function AssetChainStatsSection({
    assetId,
    displayName,
    chains,
    chainStats,
    primaryVariantByChain,
}: AssetChainStatsSectionProps) {
    const present = new Set(chains);
    const rows = CHAIN_KINDS.flatMap(chain =>
        present.has(chain)
            ? [
                  {
                      chain,
                      label: CHAINS[chain].label,
                      stats: chainStats[chain] ?? null,
                      primary: primaryVariantByChain[chain] ?? null,
                  },
              ]
            : [],
    );
    if (rows.length < 2) return null;

    return (
        <section className="mt-10">
            <h2 className="text-title-md text-text-extra-high text-balance">By chain</h2>
            <p className="mt-2 text-body-md text-text-medium text-pretty">
                Where {displayName} trades on-chain. Liquidity, volume and trades are summed across each chain&apos;s variants.
            </p>
            <div className="mt-6 overflow-hidden rounded-[24px] border border-border-light bg-white shadow-[0_8px_40px_rgba(0,0,0,0.03)]">
                <table className="w-full text-left">
                    <thead>
                        <tr className="border-b border-border-light text-[11px] uppercase tracking-[0.08em] text-text-low">
                            <th className="px-5 py-3 font-semibold">Chain</th>
                            <th className="px-5 py-3 text-right font-semibold">Liquidity</th>
                            <th className="px-5 py-3 text-right font-semibold">24h Vol</th>
                            <th className="px-5 py-3 text-right font-semibold">24h Trades</th>
                            <th className="px-5 py-3 text-right font-semibold">Variants</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => {
                            const href = row.primary
                                ? buildVariantHref(assetId, { chain: row.chain, address: row.primary.address })
                                : null;
                            return (
                                <tr key={row.chain} className="border-b border-border-extra-light last:border-b-0">
                                    <td className="px-5 py-3 text-[13px] font-medium text-text-extra-high">
                                        {href ? (
                                            <Link
                                                href={href}
                                                className="inline-flex items-center gap-2 hover:underline"
                                            >
                                                {row.label}
                                                {row.primary ? (
                                                    <span className="text-[11px] font-normal text-text-low tabular-nums">
                                                        {row.primary.symbol}
                                                    </span>
                                                ) : null}
                                            </Link>
                                        ) : (
                                            row.label
                                        )}
                                    </td>
                                    <td className="px-5 py-3 text-right text-[13px] tabular-nums text-text-extra-high">
                                        {row.stats?.liquidity != null ? formatLargeNumber(row.stats.liquidity) : '—'}
                                    </td>
                                    <td className="px-5 py-3 text-right text-[13px] tabular-nums text-text-extra-high">
                                        {row.stats?.volume24hUSD != null
                                            ? formatLargeNumber(row.stats.volume24hUSD)
                                            : '—'}
                                    </td>
                                    <td className="px-5 py-3 text-right text-[13px] tabular-nums text-text-extra-high">
                                        {formatCount(row.stats?.trade24h)}
                                    </td>
                                    <td className="px-5 py-3 text-right text-[13px] tabular-nums text-text-extra-high">
                                        {row.stats ? row.stats.variantCount : '—'}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
