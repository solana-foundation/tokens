/**
 * Per-variant execution curves derived from probe quotes.
 *
 * Impact is computed against the variant's own smallest successful rung (the
 * depth-cron idiom): source-agnostic, so Titan (which reports no impact field)
 * and Jupiter become comparable, and variant curves become comparable to each
 * other. All ratio math is BigInt fixed-point — raw amounts on 18-decimal
 * mints exceed Number.MAX_SAFE_INTEGER.
 */

import type { ExecutionQuoteRow, QuoteProvider } from '../evaluate/contract';
import type { VariantCurveRung } from './contract';

/** 1e6 fixed-point scale: keeps 2dp of bps resolution without floats. */
const RATIO_SCALE = 1_000_000n;

export interface CurvePoint {
    sizeUsd: number;
    /** Raw input actually quoted (USDC 6dp). */
    inRaw: bigint;
    /** Raw output of the winning provider. */
    outRaw: bigint;
    provider: QuoteProvider;
    impactBps: number;
}

export interface VariantCurve {
    /** Human-readable output-per-USDC at the baseline rung; display only. */
    baseEffectivePrice: string | null;
    /** Successful rungs ascending by size; the allocator's raw material. */
    points: CurvePoint[];
    /** All probe rungs (failed ones included) for the response. */
    rungs: VariantCurveRung[];
    maxProvenSizeUsd: number | null;
}

/**
 * Impact of a rung vs the baseline rung, bps with 2dp:
 * `(1 - (out_i * in_base) / (in_i * out_base)) * 1e4`, floored at 0.
 */
function impactBpsVsBase(point: { inRaw: bigint; outRaw: bigint }, base: { inRaw: bigint; outRaw: bigint }): number {
    const numer = point.outRaw * base.inRaw * RATIO_SCALE;
    const denom = point.inRaw * base.outRaw;
    if (denom === 0n) return 0;
    const ratio = numer / denom;
    const impact = Number(RATIO_SCALE - ratio) / 100;
    return impact > 0 ? Math.round(impact * 100) / 100 : 0;
}

/**
 * Build a variant's curve from its serialized probe rows. Rows must be the
 * buy-side rows of one variant, one per probe rung, in ladder order.
 */
export function buildVariantCurve(rows: readonly ExecutionQuoteRow[]): VariantCurve {
    const successful: Array<{ sizeUsd: number; inRaw: bigint; outRaw: bigint; provider: QuoteProvider }> = [];
    for (const row of rows) {
        if (row.status !== 'available') continue;
        successful.push({
            sizeUsd: Number(row.request.amount),
            inRaw: BigInt(row.best.input.rawAmount),
            outRaw: BigInt(row.best.output.rawAmount),
            provider: row.best.provider,
        });
    }
    successful.sort((a, b) => a.sizeUsd - b.sizeUsd);
    const base = successful[0] ?? null;

    const points: CurvePoint[] = successful.map(point => ({
        ...point,
        impactBps: base ? impactBpsVsBase(point, base) : 0,
    }));
    const impactBySize = new Map(points.map(point => [point.sizeUsd, point]));

    const rungs: VariantCurveRung[] = rows.map(row => {
        const sizeUsd = Number(row.request.amount);
        const point = impactBySize.get(sizeUsd) ?? null;
        return {
            sizeUsd,
            impactBps: point?.impactBps ?? null,
            provider: point?.provider ?? null,
        };
    });

    const baseRow = rows.find(
        row => row.status === 'available' && Number(row.request.amount) === base?.sizeUsd,
    );
    return {
        baseEffectivePrice:
            baseRow && baseRow.status === 'available' ? baseRow.best.effectivePrice : null,
        points,
        rungs,
        maxProvenSizeUsd: points.length > 0 ? points[points.length - 1]!.sizeUsd : null,
    };
}
