import type { GetLatestByMintsEntry } from '../../../../cloudrun-assets/src/handlers/depthCurveReads';

import type { Effect } from 'effect';

import { cloudRunQuery } from './client';
import type { CloudRunError } from './errors';

export type VariantDepthCurvesGetLatestByMintsArgs = {
    mints: string[];
    side?: 'buy' | 'sell';
    quoteMint?: string;
    source?: 'titan' | 'jupiter_lite';
};
export type VariantDepthCurvesGetLatestByMintsResult = GetLatestByMintsEntry[];

export function variantDepthCurvesGetLatestByMints(
    args: VariantDepthCurvesGetLatestByMintsArgs,
): Effect.Effect<VariantDepthCurvesGetLatestByMintsResult, CloudRunError> {
    return cloudRunQuery<VariantDepthCurvesGetLatestByMintsResult>(
        'assets',
        'variantDepthCurvesGetLatestByMints',
        { ...args },
    );
}
