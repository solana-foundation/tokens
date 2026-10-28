import { Skeleton } from '@tokens/ui/skeleton';
import { cn } from '@tokens/ui/cn';

/**
 * The registry table's own chrome with placeholder rows, the way the home
 * table shows its skeleton inside the card: toolbar, real column headers,
 * row shapes and the pagination bar paint at once and the data drops into the
 * same frame. Shown while the table streams (dev, client navigations before
 * the prefetch lands, the API-down fallback).
 */

const HEADERS = ['Token', 'Address', 'Category', 'Class', 'Value', 'Market Cap'] as const;
const ROWS = 12;

const BAR = 'rounded bg-gray-100';

/** Two provider label + value pairs, the shape of the Value cell. */
function ValueBars({ align = 'left' }: { align?: 'left' | 'right' }) {
    return (
        <div className={cn('flex flex-col gap-1.5', align === 'right' && 'items-end')}>
            {[0, 1].map(line => (
                <div key={line} className="flex items-center gap-2">
                    <Skeleton className={cn('h-2.5 w-10', BAR)} />
                    <Skeleton className={cn('h-3.5 w-16', BAR)} />
                </div>
            ))}
        </div>
    );
}

export function RegistryTableSkeleton() {
    return (
        <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24" aria-busy="true" aria-live="polite">
            <div className="flex flex-col gap-4">
                {/* Toolbar: search pill, filter chips, export button. */}
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                        <Skeleton className="h-9 w-full rounded-full bg-gray-100 sm:w-[300px]" />
                        <Skeleton className="h-9 w-[92px] rounded-full bg-gray-100" />
                    </div>
                    <Skeleton className="h-9 w-[128px] rounded-full bg-gray-100" />
                </div>

                <div className="bg-white rounded-[24px] border border-border-medium shadow-[0_8px_40px_rgba(0,0,0,0.03)] overflow-hidden">
                    <div className="hidden overflow-x-auto md:block">
                        <table className="w-full min-w-[1040px] text-left border-collapse">
                            <thead>
                                <tr className="border-b border-border-extra-light bg-gray-50/80">
                                    {HEADERS.map((label, index) => (
                                        <th
                                            key={label}
                                            className={cn(
                                                'py-3 text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light align-bottom',
                                                index === 0 ? 'pl-6 pr-4' : 'px-5',
                                            )}
                                        >
                                            {label === 'Value' ? (
                                                <span className="flex flex-col items-start leading-tight">
                                                    {label}
                                                    <span className="text-[11px] font-medium text-text-extra-low">
                                                        Allium · RWA.xyz
                                                    </span>
                                                </span>
                                            ) : label === 'Market Cap' ? (
                                                <span className="inline-flex flex-col items-start leading-tight">
                                                    {label}
                                                    <span className="text-[11px] font-medium text-text-extra-low">
                                                        CoinGecko
                                                    </span>
                                                </span>
                                            ) : (
                                                <span className="inline-flex text-nowrap items-center gap-1">
                                                    {label}
                                                </span>
                                            )}
                                        </th>
                                    ))}
                                    <th className="py-3 pl-5 pr-8 bg-gray-50/80 border-b border-border-light">
                                        <span className="sr-only">Response</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border-extra-light">
                                {Array.from({ length: ROWS }, (_, row) => (
                                    <tr key={row}>
                                        <td className="py-3.5 pl-6 pr-4">
                                            <div className="flex items-center gap-[8px]">
                                                <Skeleton className="size-[26px] shrink-0 rounded-full bg-gray-100" />
                                                <Skeleton
                                                    className={cn('h-4 bg-gray-100', row % 3 === 0 ? 'w-40' : 'w-28')}
                                                />
                                                <Skeleton className="h-3.5 w-12 bg-gray-100" />
                                            </div>
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <Skeleton className={cn('h-3.5 w-24', BAR)} />
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <Skeleton className={cn('h-3.5', BAR, row % 2 === 0 ? 'w-24' : 'w-20')} />
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <Skeleton className={cn('h-3.5', BAR, row % 2 === 0 ? 'w-28' : 'w-36')} />
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <ValueBars />
                                        </td>
                                        <td className="py-3.5 px-5">
                                            <Skeleton className={cn('h-3.5 w-16', BAR)} />
                                        </td>
                                        <td className="py-3.5 pl-5 pr-8">
                                            <Skeleton className="ml-auto size-8 rounded-full bg-gray-100" />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {/* Phone list: sort header, then the stacked rows of RegistryMobileList. */}
                    <div className="md:hidden">
                        <div className="flex items-center justify-between border-b border-border-light bg-gray-50/80 px-4 py-2.5">
                            <Skeleton className={cn('h-3.5 w-12', BAR)} />
                            <Skeleton className={cn('h-3.5 w-12', BAR)} />
                        </div>
                        <ul className="divide-y divide-border-extra-light">
                            {Array.from({ length: ROWS }, (_, row) => (
                                <li key={row} className="flex items-center gap-3 px-4 py-3">
                                    <Skeleton className="size-8 shrink-0 rounded-full bg-gray-100" />
                                    <div className="flex flex-1 flex-col gap-1.5">
                                        <Skeleton className={cn('h-4', BAR, row % 3 === 0 ? 'w-24' : 'w-16')} />
                                        <Skeleton className={cn('h-3 w-28', BAR)} />
                                    </div>
                                    <Skeleton className={cn('size-4', BAR)} />
                                </li>
                            ))}
                        </ul>
                    </div>
                    {/* Pagination bar. */}
                    <div className="border-t border-border-light px-8 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <Skeleton className={cn('h-3.5 w-44', BAR)} />
                            <div className="flex items-center gap-2">
                                <Skeleton className={cn('h-3.5 w-14', BAR)} />
                                <Skeleton className="h-9 w-[88px] rounded-md bg-gray-100" />
                                <Skeleton className="h-9 w-9 rounded-full bg-gray-100" />
                                <Skeleton className="h-9 w-9 rounded-full bg-gray-100" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
