export type FloatingMarketFeedSize = 15 | 25 | 50;
export type FloatingMarketFeedSource = 'all' | 'news' | 'tweets';

export interface FloatingMarketFeedSettings {
    feedSize: FloatingMarketFeedSize;
    showNews: boolean;
    showTweets: boolean;
    /** Heat map category shown in the feed's mini map (a curated list slug). */
    heatmapSector: string;
}

export const FLOATING_MARKET_FEED_SIZE_OPTIONS = [15, 25, 50] as const satisfies readonly FloatingMarketFeedSize[];

export const DEFAULT_FLOATING_MARKET_FEED_SETTINGS: FloatingMarketFeedSettings = {
    feedSize: 25,
    showNews: false,
    showTweets: true,
    heatmapSector: 'stocks',
};

const SECTOR_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The category after `current` among those the heat map currently has; wraps around. */
export function getNextHeatmapSector(current: string, available: readonly string[]): string {
    if (available.length === 0) return current;
    const index = available.indexOf(current);
    return available[(index + 1) % available.length] ?? current;
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isFloatingMarketFeedSize(value: unknown): value is FloatingMarketFeedSize {
    return FLOATING_MARKET_FEED_SIZE_OPTIONS.includes(value as FloatingMarketFeedSize);
}

export function getNextFloatingMarketFeedSize(current: FloatingMarketFeedSize): FloatingMarketFeedSize {
    const currentIndex = FLOATING_MARKET_FEED_SIZE_OPTIONS.indexOf(current);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % FLOATING_MARKET_FEED_SIZE_OPTIONS.length;
    return FLOATING_MARKET_FEED_SIZE_OPTIONS[nextIndex] ?? DEFAULT_FLOATING_MARKET_FEED_SETTINGS.feedSize;
}

export function sanitizeFloatingMarketFeedSettings(value: unknown): FloatingMarketFeedSettings {
    if (!isSettingsRecord(value)) return DEFAULT_FLOATING_MARKET_FEED_SETTINGS;

    const feedSize = isFloatingMarketFeedSize(value.feedSize)
        ? value.feedSize
        : DEFAULT_FLOATING_MARKET_FEED_SETTINGS.feedSize;
    const showNews =
        typeof value.showNews === 'boolean' ? value.showNews : DEFAULT_FLOATING_MARKET_FEED_SETTINGS.showNews;
    const showTweets =
        typeof value.showTweets === 'boolean' ? value.showTweets : DEFAULT_FLOATING_MARKET_FEED_SETTINGS.showTweets;
    const heatmapSector =
        typeof value.heatmapSector === 'string' && SECTOR_ID_PATTERN.test(value.heatmapSector)
            ? value.heatmapSector
            : DEFAULT_FLOATING_MARKET_FEED_SETTINGS.heatmapSector;

    if (!showNews && !showTweets) return { ...DEFAULT_FLOATING_MARKET_FEED_SETTINGS, heatmapSector };

    return {
        feedSize,
        showNews,
        showTweets,
        heatmapSector,
    };
}

export function resolveNextFloatingMarketFeedSettings(
    previous: FloatingMarketFeedSettings,
    patch: Partial<FloatingMarketFeedSettings>,
): FloatingMarketFeedSettings {
    const next = {
        ...previous,
        ...patch,
    };

    if (patch.showNews === false && !next.showNews && !next.showTweets) {
        return {
            ...next,
            showTweets: true,
        };
    }

    if (patch.showTweets === false && !next.showNews && !next.showTweets) {
        return {
            ...next,
            showNews: true,
        };
    }

    return sanitizeFloatingMarketFeedSettings(next);
}

export function getFloatingMarketFeedSource(settings: FloatingMarketFeedSettings): FloatingMarketFeedSource {
    if (settings.showNews && settings.showTweets) return 'all';
    if (settings.showNews) return 'news';
    if (settings.showTweets) return 'tweets';
    return 'all';
}

export function getFloatingMarketFeedTitle(_settings: FloatingMarketFeedSettings): string {
    return 'Latest Updates';
}

export function getFloatingMarketFeedEmptyNoun(settings: FloatingMarketFeedSettings): string {
    const source = getFloatingMarketFeedSource(settings);
    if (source === 'news') return 'news';
    if (source === 'tweets') return 'tweets';
    return 'updates';
}
