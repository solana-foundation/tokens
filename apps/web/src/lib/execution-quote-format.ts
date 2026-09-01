/** The API normalizes provider impact to a decimal ratio (0.9846 = 98.46%). */
export function formatPriceImpactRatio(priceImpactRatio: number | null): string {
    if (priceImpactRatio === null || !Number.isFinite(priceImpactRatio)) return '—';
    const percentage = priceImpactRatio * 100;
    if (percentage > 0 && percentage < 0.001) return '<0.001%';
    return `${percentage.toFixed(Math.abs(percentage) < 1 ? 3 : 2)}%`;
}

export function fullPriceImpactRatio(priceImpactRatio: number | null): string | undefined {
    if (priceImpactRatio === null || !Number.isFinite(priceImpactRatio)) return undefined;
    return `${priceImpactRatio * 100}%`;
}

/** Friendly names for known Jupiter engines while preserving future ids. */
export function formatExecutionRouterLabel(router: string | null): string {
    if (!router) return '—';
    const known: Record<string, string> = {
        metis: 'Metis',
        jupiterz: 'JupiterZ',
        dflow: 'Dflow',
        okx: 'OKX',
    };
    return known[router.toLowerCase()] ?? router;
}
