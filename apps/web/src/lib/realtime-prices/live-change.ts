/**
 * Carry a snapshot percent change forward to a live price.
 *
 * The API gives us a price and a change over some window from the same
 * snapshot, so the window's reference price is `price / (1 + change)`. A live
 * tick then yields the current change against that same reference, which is
 * what the chart header shows too. Returns the snapshot change when the inputs
 * cannot support the math.
 */
export function applyLiveChangePercent(
    snapshotPrice: number | null | undefined,
    snapshotChangePercent: number | null | undefined,
    livePrice: number | null | undefined,
): number | null {
    const change =
        typeof snapshotChangePercent === 'number' && Number.isFinite(snapshotChangePercent)
            ? snapshotChangePercent
            : null;
    if (change == null) return null;
    if (typeof livePrice !== 'number' || !Number.isFinite(livePrice) || livePrice <= 0) return change;
    if (typeof snapshotPrice !== 'number' || !Number.isFinite(snapshotPrice) || snapshotPrice <= 0) return change;
    const denominator = 1 + change / 100;
    if (!Number.isFinite(denominator) || denominator <= 0) return change;
    const referencePrice = snapshotPrice / denominator;
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) return change;
    const live = (livePrice / referencePrice - 1) * 100;
    return Number.isFinite(live) ? live : change;
}
