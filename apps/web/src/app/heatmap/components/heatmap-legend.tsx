import { legendStops, NO_DATA_FILL, NO_DATA_HATCH } from '../lib/color';
import type { HeatmapPeriod } from '../lib/types';

export function HeatmapLegend({ period }: { period: HeatmapPeriod }) {
    const stops = legendStops(period);

    return (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-x-8 gap-y-3 text-[12px] leading-[1.4] text-text-low">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="font-medium text-text-medium">{period} price change</span>
                <ol aria-label={`${period} price change scale`} className="flex">
                    {stops.map(stop => (
                        <li key={stop.bin.step} className="flex w-[52px] flex-col items-center gap-1">
                            <span
                                aria-hidden="true"
                                className="h-3 w-full border-r-2 border-white"
                                style={{ background: stop.bin.fill }}
                            />
                            <span className="tabular-nums">{stop.label}</span>
                        </li>
                    ))}
                </ol>
                <span className="flex items-center gap-1.5">
                    <span
                        aria-hidden="true"
                        className="h-3 w-5 rounded-[2px]"
                        style={{
                            background: `repeating-linear-gradient(135deg, ${NO_DATA_HATCH} 0 2px, transparent 2px 7px), ${NO_DATA_FILL}`,
                        }}
                    />
                    No data
                </span>
            </div>
            <p className="max-w-[520px] text-pretty md:text-right">
                Bigger tiles traded more on Solana in the last 24h. Areas are compressed, not proportional, so assets
                and categories with less volume stay visible.
            </p>
        </div>
    );
}
