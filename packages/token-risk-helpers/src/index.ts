import type { CuratedListSlug } from '@tokens/asset-registry/curated-lists';

export type RiskStatus = 'risk' | 'warning' | 'safe' | 'info';

export type MarketGrade = 'A' | 'B' | 'C';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface MarketScoreInput {
    /** Absolute liquidity in USD */
    liquidityUsd: number | null;
    /** Market cap in USD */
    marketCapUsd: number | null;
    /** Number of unique holder addresses */
    holderCount: number | null;
    /** Top 10 holders percentage (0-100) */
    top10HoldersPercent: number | null;
    /** 24h trading volume in USD (used for vol/liquidity ratio) */
    volume24hUsd: number | null;
    /** 7-day trading volume in USD */
    volume7dUsd: number | null;
    /** Token mint timestamp (ISO string or Date) */
    tokenMintTime: string | Date | null;
    /** Token address for curated list lookups */
    tokenAddress: string;
    /**
     * Curated list slugs this token belongs to (DB-backed effective
     * membership, provided by the caller). Absent/empty means no curated
     * exemptions apply — conservative by default.
     */
    curatedListSlugs?: readonly string[];
}

export interface MarketScoreComponentResult {
    /** Component score 0-100 */
    score: number;
    /** Human-readable status */
    status: RiskStatus;
    /** Whether data was available */
    hasData: boolean;
}

export interface MarketScoreResult {
    /** Final market score 0-100 */
    score: number;
    /** Grade A/B/C */
    grade: MarketGrade;
    /** Human-readable label */
    label: string;
    /** Color tone for UI */
    tone: RiskStatus;
    /** Whether this is a trusted launch */
    isTrustedLaunch: boolean;
    /** Limiting factors that capped the score */
    caps: string[];
    /** Borderline signals detected */
    borderlineSignals: string[];
    /** Whether we have enough data to compute a score */
    hasInsufficientData: boolean;
    /** Reason for insufficient data */
    insufficientDataReason: string | null;
    /** Component scores for display */
    components: {
        liquidityHealth: MarketScoreComponentResult;
        holderDistribution: MarketScoreComponentResult;
        tradingActivity: MarketScoreComponentResult;
        holderCount: MarketScoreComponentResult;
    };
    /** Token age in days (for display) */
    tokenAgeDays: number | null;
}

interface ThresholdPoint {
    threshold: number;
    score: number;
}

function interpolateScore(value: number, points: ThresholdPoint[]): number {
    if (points.length === 0) return 0;
    if (points.length === 1) return points[0]!.score;

    if (value <= points[0]!.threshold) return points[0]!.score;
    if (value >= points[points.length - 1]!.threshold) return points[points.length - 1]!.score;

    for (let i = 0; i < points.length - 1; i++) {
        const lower = points[i]!;
        const upper = points[i + 1]!;
        if (value < lower.threshold || value > upper.threshold) continue;
        const range = upper.threshold - lower.threshold;
        if (range === 0) return lower.score;
        const ratio = (value - lower.threshold) / range;
        return lower.score + ratio * (upper.score - lower.score);
    }

    return points[points.length - 1]!.score;
}

function interpolateDescendingThresholdScore(value: number, points: ThresholdPoint[]): number {
    if (points.length === 0) return 0;
    if (points.length === 1) return points[0]!.score;

    const sorted = points.slice().sort((a, b) => a.threshold - b.threshold);
    if (value <= sorted[0]!.threshold) return sorted[0]!.score;
    if (value >= sorted[sorted.length - 1]!.threshold) return sorted[sorted.length - 1]!.score;

    for (let i = 0; i < sorted.length - 1; i++) {
        const lower = sorted[i]!;
        const upper = sorted[i + 1]!;
        if (value < lower.threshold || value > upper.threshold) continue;
        const range = upper.threshold - lower.threshold;
        if (range === 0) return lower.score;
        const ratio = (value - lower.threshold) / range;
        return lower.score + ratio * (upper.score - lower.score);
    }

    return sorted[sorted.length - 1]!.score;
}

const LIQUIDITY_ABSOLUTE_THRESHOLDS: ThresholdPoint[] = [
    { threshold: 0, score: 0 },
    { threshold: 100_000, score: 20 },
    { threshold: 500_000, score: 40 },
    { threshold: 1_000_000, score: 60 },
    { threshold: 5_000_000, score: 80 },
    { threshold: 10_000_000, score: 100 },
];

const LIQUIDITY_RATIO_THRESHOLDS: ThresholdPoint[] = [
    { threshold: 0, score: 0 },
    { threshold: 0.001, score: 20 },
    { threshold: 0.005, score: 40 },
    { threshold: 0.01, score: 60 },
    { threshold: 0.03, score: 80 },
    { threshold: 0.05, score: 100 },
];

function scoreLiquidityHealth(liquidityUsd: number | null, marketCapUsd: number | null): MarketScoreComponentResult {
    if (liquidityUsd == null || liquidityUsd <= 0) return { score: 0, status: 'info', hasData: false };

    const absoluteScore = interpolateScore(liquidityUsd, LIQUIDITY_ABSOLUTE_THRESHOLDS);

    let ratioScore = 0;
    if (marketCapUsd != null && marketCapUsd > 0) {
        const ratio = liquidityUsd / marketCapUsd;
        ratioScore = interpolateScore(ratio, LIQUIDITY_RATIO_THRESHOLDS);
        if (liquidityUsd < 100_000) ratioScore = Math.min(ratioScore, 20);
    }

    const score = Math.max(absoluteScore, ratioScore);
    const status = score >= 60 ? 'safe' : score >= 40 ? 'warning' : 'risk';
    return { score, status, hasData: true };
}

const HOLDER_DISTRIBUTION_THRESHOLDS: ThresholdPoint[] = [
    { threshold: 20, score: 100 },
    { threshold: 30, score: 80 },
    { threshold: 40, score: 60 },
    { threshold: 50, score: 40 },
    { threshold: 80, score: 0 },
];

function scoreHolderDistribution(top10HoldersPercent: number | null, isExempt: boolean): MarketScoreComponentResult {
    if (isExempt) return { score: 100, status: 'safe', hasData: true };
    if (top10HoldersPercent == null || top10HoldersPercent <= 0) return { score: 50, status: 'info', hasData: false };

    const score = interpolateDescendingThresholdScore(top10HoldersPercent, HOLDER_DISTRIBUTION_THRESHOLDS);
    const status = score >= 60 ? 'safe' : score >= 40 ? 'warning' : 'risk';
    return { score, status, hasData: true };
}

const VOLUME_ABSOLUTE_THRESHOLDS: ThresholdPoint[] = [
    { threshold: 0, score: 0 },
    { threshold: 50_000, score: 20 },
    { threshold: 100_000, score: 40 },
    { threshold: 500_000, score: 60 },
    { threshold: 1_000_000, score: 80 },
    { threshold: 5_000_000, score: 100 },
];

function scoreVolumeToLiquidityRatio(ratio: number): number {
    if (ratio >= 0.5 && ratio <= 4) return 100;
    if (ratio >= 0.3 && ratio < 0.5) return 70 + ((ratio - 0.3) / 0.2) * 30;
    if (ratio > 4 && ratio <= 5) return 100 - ((ratio - 4) / 1) * 30;
    if (ratio >= 0.1 && ratio < 0.3) return 40 + ((ratio - 0.1) / 0.2) * 30;
    if (ratio > 5 && ratio <= 7) return 70 - ((ratio - 5) / 2) * 30;
    if (ratio < 0.1) return 40;
    return 0;
}

function scoreTradingActivity(
    volume7dUsd: number | null,
    volume24hUsd: number | null,
    liquidityUsd: number | null,
): MarketScoreComponentResult {
    if (volume7dUsd == null || volume7dUsd <= 0) return { score: 0, status: 'info', hasData: false };

    const absoluteScore = interpolateScore(volume7dUsd, VOLUME_ABSOLUTE_THRESHOLDS);

    let ratioScore = 0;
    if (liquidityUsd != null && liquidityUsd > 0) {
        const dailyVolumeUsd = volume24hUsd ?? volume7dUsd / 7;
        const ratio = dailyVolumeUsd / liquidityUsd;
        ratioScore = scoreVolumeToLiquidityRatio(ratio);
    }

    const score = Math.max(absoluteScore, ratioScore);
    const status = score >= 60 ? 'safe' : score >= 40 ? 'warning' : 'risk';
    return { score, status, hasData: true };
}

const HOLDER_COUNT_THRESHOLDS: ThresholdPoint[] = [
    { threshold: 0, score: 0 },
    { threshold: 200, score: 20 },
    { threshold: 500, score: 40 },
    { threshold: 1_000, score: 60 },
    { threshold: 2_000, score: 80 },
    { threshold: 5_000, score: 100 },
];

function scoreHolderCount(holderCount: number | null): MarketScoreComponentResult {
    if (holderCount == null || holderCount <= 0) return { score: 0, status: 'info', hasData: false };

    const score = interpolateScore(holderCount, HOLDER_COUNT_THRESHOLDS);
    const status = score >= 60 ? 'safe' : score >= 40 ? 'warning' : 'risk';
    return { score, status, hasData: true };
}

function computeTokenAgeDays(tokenMintTime: string | Date | null): number | null {
    if (tokenMintTime == null) return null;
    try {
        const mintDate = typeof tokenMintTime === 'string' ? new Date(tokenMintTime) : tokenMintTime;
        if (Number.isNaN(mintDate.getTime())) return null;
        const diffMs = new Date().getTime() - mintDate.getTime();
        return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
    } catch {
        return null;
    }
}

export const CONCENTRATION_EXEMPT_LISTS: readonly CuratedListSlug[] = ['currencies', 'stocks', 'lsts'];
export const TRUSTED_LAUNCH_LISTS: readonly CuratedListSlug[] = ['majors', 'lsts', 'currencies', 'rwas', 'stocks'];

function isInCuratedList(input: MarketScoreInput, listIds: readonly CuratedListSlug[]): boolean {
    const memberships = input.curatedListSlugs;
    if (!memberships || memberships.length === 0) return false;
    return memberships.some(slug => (listIds as readonly string[]).includes(slug));
}

function isConcentrationExempt(input: MarketScoreInput): boolean {
    return isInCuratedList(input, CONCENTRATION_EXEMPT_LISTS);
}

function isTrustedLaunchEligible(input: MarketScoreInput): boolean {
    return isInCuratedList(input, TRUSTED_LAUNCH_LISTS);
}

interface CapResult {
    id:
        | 'whale-dominance'
        | 'ghost-token'
        | 'no-liquidity'
        | 'dead-token'
        | 'very-new-token'
        | 'low-market-cap'
        | 'high-concentration'
        | 'unusual-volume'
        | 'new-token';
    maxScore: number;
    reason: string;
}

function computeCaps(input: MarketScoreInput, tokenAgeDays: number | null): CapResult[] {
    const caps: CapResult[] = [];

    if (input.top10HoldersPercent != null && input.top10HoldersPercent > 80) {
        caps.push({ id: 'whale-dominance', maxScore: 69, reason: 'Whale Dominance (>80% top 10)' });
    }
    if (input.holderCount != null && input.holderCount < 20) {
        caps.push({ id: 'ghost-token', maxScore: 69, reason: 'Ghost Token (<20 holders)' });
    }
    if (input.liquidityUsd != null && input.liquidityUsd < 1_000) {
        caps.push({ id: 'no-liquidity', maxScore: 69, reason: 'No Liquidity (<$1K)' });
    }
    if (input.volume7dUsd != null && input.volume7dUsd < 100) {
        caps.push({ id: 'dead-token', maxScore: 69, reason: 'Dead Token (<$100 volume)' });
    }
    if (tokenAgeDays != null && tokenAgeDays < 1) {
        caps.push({ id: 'very-new-token', maxScore: 69, reason: 'Very New Token (<1 day old)' });
    }
    if (input.marketCapUsd != null && input.marketCapUsd < 100_000) {
        caps.push({ id: 'low-market-cap', maxScore: 69, reason: 'Low Market Cap (<$100K)' });
    }

    if (input.top10HoldersPercent != null && input.top10HoldersPercent > 50 && input.top10HoldersPercent <= 80) {
        if (!isConcentrationExempt(input)) {
            caps.push({ id: 'high-concentration', maxScore: 84, reason: 'High Concentration (>50% top 10)' });
        }
    }
    if (input.liquidityUsd != null && input.liquidityUsd > 0) {
        const dailyVolumeUsd = input.volume24hUsd ?? (input.volume7dUsd == null ? null : input.volume7dUsd / 7);
        if (dailyVolumeUsd != null && dailyVolumeUsd > 0) {
            const ratio = dailyVolumeUsd / input.liquidityUsd;
            if (ratio > 7) caps.push({ id: 'unusual-volume', maxScore: 84, reason: 'Unusual Volume (>7x vol/liq)' });
        }
    }
    if (tokenAgeDays != null && tokenAgeDays < 7) {
        caps.push({ id: 'new-token', maxScore: 84, reason: 'New Token (<1 week old)' });
    }

    return caps;
}

interface BorderlineResult {
    id: 'holder-count' | 'concentration' | 'liquidity' | 'market-cap' | 'volume' | 'token-age';
    signal: string;
    triggered: boolean;
}

function computeBorderlineSignals(input: MarketScoreInput, tokenAgeDays: number | null): BorderlineResult[] {
    const signals: BorderlineResult[] = [];
    const isExempt = isConcentrationExempt(input);

    if (input.holderCount != null) {
        signals.push({
            id: 'holder-count',
            signal: 'Borderline Holder Count (20-500)',
            triggered: input.holderCount >= 20 && input.holderCount <= 500,
        });
    }

    if (input.top10HoldersPercent != null && !isExempt) {
        signals.push({
            id: 'concentration',
            signal: 'Borderline Concentration (40-50%)',
            triggered: input.top10HoldersPercent >= 40 && input.top10HoldersPercent <= 50,
        });
    }

    if (input.liquidityUsd != null) {
        signals.push({
            id: 'liquidity',
            signal: 'Borderline Liquidity ($100K-$200K)',
            triggered: input.liquidityUsd >= 100_000 && input.liquidityUsd <= 200_000,
        });
    }

    if (input.marketCapUsd != null) {
        signals.push({
            id: 'market-cap',
            signal: 'Borderline Market Cap ($100K-$500K)',
            triggered: input.marketCapUsd >= 100_000 && input.marketCapUsd <= 500_000,
        });
    }

    if (input.volume7dUsd != null) {
        signals.push({
            id: 'volume',
            signal: 'Borderline Volume ($100-$10K)',
            triggered: input.volume7dUsd >= 100 && input.volume7dUsd <= 10_000,
        });
    }

    if (tokenAgeDays != null) {
        signals.push({
            id: 'token-age',
            signal: 'Borderline Token Age (1-4 weeks)',
            triggered: tokenAgeDays >= 7 && tokenAgeDays <= 28,
        });
    }

    return signals;
}

const WEIGHTS = {
    liquidityHealth: 30,
    holderDistribution: 20,
    tradingActivity: 20,
    holderCount: 15,
} as const;

const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);

function createFixedScoreResult(score: number, grade: MarketGrade): MarketScoreResult {
    const safeScore = clamp(Math.round(score), 0, 100);
    const label = getGradeLabel(grade);
    const tone = getGradeTone(grade);

    const fullSafe: MarketScoreComponentResult = { score: 100, status: 'safe', hasData: true };

    return {
        score: safeScore,
        grade,
        label,
        tone,
        isTrustedLaunch: false,
        caps: [],
        borderlineSignals: [],
        hasInsufficientData: false,
        insufficientDataReason: null,
        components: {
            liquidityHealth: fullSafe,
            holderDistribution: fullSafe,
            tradingActivity: fullSafe,
            holderCount: fullSafe,
        },
        tokenAgeDays: null,
    };
}

export function computeMarketScore(input: MarketScoreInput): MarketScoreResult {
    if (input.tokenAddress.trim() === SOL_MINT) {
        return createFixedScoreResult(100, 'A');
    }

    if (
        (input.liquidityUsd == null || input.liquidityUsd < 1_000) &&
        (input.marketCapUsd == null || input.marketCapUsd < 1_000)
    ) {
        return createInsufficientDataResult('Insufficient market data (liquidity and market cap below $1K or missing)');
    }

    const tokenAgeDays = computeTokenAgeDays(input.tokenMintTime);
    const isExempt = isConcentrationExempt(input);

    const liquidityHealth = scoreLiquidityHealth(input.liquidityUsd, input.marketCapUsd);
    const holderDistribution = scoreHolderDistribution(input.top10HoldersPercent, isExempt);
    const tradingActivity = scoreTradingActivity(input.volume7dUsd, input.volume24hUsd, input.liquidityUsd);
    const holderCount = scoreHolderCount(input.holderCount);

    const rawScore =
        (liquidityHealth.score * WEIGHTS.liquidityHealth +
            holderDistribution.score * WEIGHTS.holderDistribution +
            tradingActivity.score * WEIGHTS.tradingActivity +
            holderCount.score * WEIGHTS.holderCount) /
        TOTAL_WEIGHT;

    let score = clamp(Math.round(rawScore), 0, 100);

    const caps = computeCaps(input, tokenAgeDays);
    const appliedCaps: string[] = [];

    for (const cap of caps) {
        if (score <= cap.maxScore) continue;
        score = cap.maxScore;
        appliedCaps.push(cap.reason);
    }

    const borderlineResults = computeBorderlineSignals(input, tokenAgeDays);
    const triggeredBorderlines = borderlineResults.filter(b => b.triggered);
    const borderlineSignals = triggeredBorderlines.map(b => b.signal);

    const directCapIds = new Set(caps.filter(cap => appliedCaps.includes(cap.reason)).map(cap => cap.id));
    const effectiveBorderlineCount = triggeredBorderlines.filter(b => {
        switch (b.id) {
            case 'holder-count':
                return !directCapIds.has('ghost-token');
            case 'concentration':
                return !directCapIds.has('high-concentration') && !directCapIds.has('whale-dominance');
            case 'liquidity':
                return !directCapIds.has('no-liquidity');
            case 'market-cap':
                return !directCapIds.has('low-market-cap');
            case 'volume':
                return !directCapIds.has('dead-token') && !directCapIds.has('unusual-volume');
            case 'token-age':
                return !directCapIds.has('very-new-token') && !directCapIds.has('new-token');
        }
    }).length;

    if (effectiveBorderlineCount >= 4 && score > 69) {
        score = 69;
        appliedCaps.push('Multiple Risk Signals (4+ borderline metrics)');
    } else if (effectiveBorderlineCount >= 3 && score > 84) {
        score = 84;
        appliedCaps.push('Elevated Risk (3 borderline metrics)');
    }

    const isTrustedLaunch = isTrustedLaunchEligible(input) && tokenAgeDays != null && tokenAgeDays <= 21;
    if (isTrustedLaunch && score < 70) score = 70;

    const grade = getGrade(score);
    const label = isTrustedLaunch && grade === 'B' ? 'Trusted Launch' : getGradeLabel(grade);
    const tone = getGradeTone(grade);

    return {
        score,
        grade,
        label,
        tone,
        isTrustedLaunch,
        caps: appliedCaps,
        borderlineSignals,
        hasInsufficientData: false,
        insufficientDataReason: null,
        components: {
            liquidityHealth,
            holderDistribution,
            tradingActivity,
            holderCount,
        },
        tokenAgeDays,
    };
}

function createInsufficientDataResult(reason: string): MarketScoreResult {
    const score = 0;
    const grade = getGrade(score);
    const emptyComponent: MarketScoreComponentResult = { score: 0, status: 'info', hasData: false };
    return {
        score,
        grade,
        label: 'Insufficient Data',
        tone: getGradeTone(grade),
        isTrustedLaunch: false,
        caps: [],
        borderlineSignals: [],
        hasInsufficientData: true,
        insufficientDataReason: reason,
        components: {
            liquidityHealth: emptyComponent,
            holderDistribution: emptyComponent,
            tradingActivity: emptyComponent,
            holderCount: emptyComponent,
        },
        tokenAgeDays: null,
    };
}

function getGrade(score: number): MarketGrade {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    return 'C';
}

function getGradeLabel(grade: MarketGrade): string {
    switch (grade) {
        case 'A':
            return 'Established';
        case 'B':
            return 'Speculative';
        case 'C':
            return 'Weak Metrics';
    }
}

function getGradeTone(grade: MarketGrade): RiskStatus {
    switch (grade) {
        case 'A':
            return 'safe';
        case 'B':
            return 'warning';
        case 'C':
            return 'risk';
    }
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
