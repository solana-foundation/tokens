import type { HeatmapPeriod } from './types';

/**
 * Stepped diverging scale for price change: three steps down, a neutral gray
 * midpoint, three steps up. The arms are orange-red and teal-green rather than
 * pure red/green so equal steps stay separable under deuteranopia; the signed
 * percentage on each tile is the secondary encoding for the palest steps.
 */
export interface ChangeBin {
    /** -3 … +3; 0 is the neutral midpoint. */
    step: -3 | -2 | -1 | 0 | 1 | 2 | 3;
    fill: string;
    /** Ink that clears 4.5:1 on `fill`. */
    ink: string;
    inkMuted: string;
}

const DARK_INK = '#0b0b0b';
const DARK_INK_MUTED = 'rgba(11, 11, 11, 0.66)';
const LIGHT_INK = '#ffffff';
const LIGHT_INK_MUTED = 'rgba(255, 255, 255, 0.82)';

const BINS: Record<ChangeBin['step'], ChangeBin> = {
    [-3]: { step: -3, fill: '#cf3a2b', ink: LIGHT_INK, inkMuted: LIGHT_INK_MUTED },
    [-2]: { step: -2, fill: '#ee7a60', ink: DARK_INK, inkMuted: DARK_INK_MUTED },
    [-1]: { step: -1, fill: '#f6a892', ink: DARK_INK, inkMuted: DARK_INK_MUTED },
    0: { step: 0, fill: '#e9e8e4', ink: DARK_INK, inkMuted: DARK_INK_MUTED },
    1: { step: 1, fill: '#8fd6ca', ink: DARK_INK, inkMuted: DARK_INK_MUTED },
    2: { step: 2, fill: '#3fb3a6', ink: DARK_INK, inkMuted: DARK_INK_MUTED },
    3: { step: 3, fill: '#0b7a75', ink: LIGHT_INK, inkMuted: LIGHT_INK_MUTED },
};

/** Missing change is not "flat": it gets its own hatched swatch, never the neutral midpoint. */
export const NO_DATA_FILL = '#f4f3f0';
export const NO_DATA_HATCH = 'rgba(11, 11, 11, 0.09)';
export const NO_DATA_INK = '#52514e';

/**
 * Absolute % thresholds separating steps 0|1, 1|2, 2|3. Gray means exactly what the tile prints:
 * a change that rounds to 0.00%. Any visible move is coloured up or down.
 */
const FLAT = 0.005;
const THRESHOLDS: Record<HeatmapPeriod, readonly [number, number, number]> = {
    '24h': [FLAT, 1.5, 4],
    '1h': [FLAT, 0.5, 1.5],
};

export function changeBin(change: number | null | undefined, period: HeatmapPeriod): ChangeBin | null {
    if (typeof change !== 'number' || !Number.isFinite(change)) return null;

    const [flat, mid, strong] = THRESHOLDS[period];
    const magnitude = Math.abs(change);
    const size = magnitude < flat ? 0 : magnitude < mid ? 1 : magnitude < strong ? 2 : 3;
    if (size === 0) return BINS[0];

    return BINS[(change < 0 ? -size : size) as ChangeBin['step']];
}
