import { Suspense, type ReactNode } from 'react';

import { fetchApiAppJsonOrNull } from '@/lib/api-app';
import { normalizePegHealth, normalizeStructuralHealth } from '@/lib/stablecoin-health';
import { RiskSectionSkeleton, RiskSectionState } from '@/app/_components/risk/risk-section-shell';
import { StablecoinHealthPanel } from '@/app/_components/risk/stablecoin-health-panel';
import type { MarketScoreInput } from '@/app/token/[address]/components/token-risk-helpers';
import type { RiskTag } from '@/app/token/[address]/components/token-risk-display';

interface AssetRiskSectionProps {
    assetId: string;
    mint: string;
}

interface V1RiskDetailsResponse {
    assetId: string;
    mint: string;
    risk: {
        ok: boolean;
        reason?: string;
        message?: string;
        marketScoreInput?: MarketScoreInput;
        tags?: RiskTag[];
        lastUpdatedAt?: number | null;
        /** Stablecoin-only Webacy blocks; decoded defensively (older API builds omit them). */
        pegHealth?: unknown;
        structuralHealth?: unknown;
    };
}

export function AssetRiskSection({ assetId, mint }: AssetRiskSectionProps) {
    return (
        <div className="mt-16">
            <h3 className="text-title-md text-text-extra-high mb-6 text-balance">Security</h3>
            <Suspense fallback={<RiskSectionSkeleton />}>
                <RiskSectionLoader assetId={assetId} mint={mint} />
            </Suspense>
        </div>
    );
}

async function RiskSectionLoader({ assetId, mint }: { assetId: string; mint: string }) {
    const data = await fetchApiAppJsonOrNull<V1RiskDetailsResponse>(
        `/api/v1/assets/${encodeURIComponent(assetId)}/risk-details?mint=${encodeURIComponent(mint)}`,
        { next: { revalidate: 300 } },
    );

    if (!data) {
        return (
            <RiskSectionState
                state={{
                    kind: 'unavailable',
                    title: 'Security data unavailable',
                    message: 'Couldn’t load market analysis right now.',
                }}
            />
        );
    }

    // The stablecoin blocks ride along on the same payload regardless of
    // whether the market score is ready, so render them above whatever the
    // risk state resolves to.
    const pegHealth = normalizePegHealth(data.risk.pegHealth);
    const structuralHealth = normalizeStructuralHealth(data.risk.structuralHealth);
    const healthPanel =
        pegHealth || structuralHealth ? (
            <StablecoinHealthPanel
                pegHealth={pegHealth}
                structuralHealth={structuralHealth}
                mint={mint}
                className="mb-4 md:mb-6"
            />
        ) : null;

    return (
        <>
            {healthPanel}
            {renderRiskState(data)}
        </>
    );
}

function renderRiskState(data: V1RiskDetailsResponse): ReactNode {
    if (!data.risk.ok) {
        if (data.risk.reason === 'not_configured') {
            return (
                <RiskSectionState
                    state={{
                        kind: 'unavailable',
                        title: 'Market analysis not configured',
                        message: (
                            <>
                                Set <span className="font-sans">DD_API_KEY</span> on the server to enable market
                                analysis.
                            </>
                        ),
                    }}
                />
            );
        }

        return (
            <RiskSectionState
                state={{
                    kind: 'unavailable',
                    title: 'Security data unavailable',
                    message: data.risk.message ?? 'Couldn’t load security data.',
                }}
            />
        );
    }

    const marketScoreInput = data.risk.marketScoreInput;
    if (!marketScoreInput) {
        return (
            <RiskSectionState
                state={{
                    kind: 'unavailable',
                    title: 'Security data unavailable',
                    message: 'Risk details not available in cache yet.',
                }}
            />
        );
    }

    return <RiskSectionState state={{ kind: 'ready', tags: data.risk.tags ?? [], marketScoreInput }} />;
}
