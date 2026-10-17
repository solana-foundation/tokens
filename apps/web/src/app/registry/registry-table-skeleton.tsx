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
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[1040px] text-left border-collapse">
                            <thead>
                                <tr className="border-b border-border-extra-light bg-gray-50/80">
                                    {HEADERS.map((label, index) => (
                                        <th
                                            key={label}
                                            className={cn(
                                                'py-3 text-[12px] md:text-[14px] font-medium text-text-high bg-gray-50/80 border-b border-border-light',
                                                index === 0 ? 'pl-4 pr-3 md:pl-6 md:pr-4' : 'px-3 md:px-5',
                                                label === 'Market Cap' && 'text-right',
                                            )}
                                        >
                                            <span className="inline-flex text-nowrap items-center gap-1">{label}</span>
                                        </th>
                                    ))}
                                    <th className="py-3 pl-3 md:pl-5 pr-4 md:pr-8 bg-gray-50/80 border-b border-border-light">
                                        <span className="sr-only">Response</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border-extra-light">
                                {Array.from({ length: ROWS }, (_, row) => (
                                    <tr key={row}>
                                        <td className="py-3.5 pl-4 pr-3 md:pl-6 md:pr-4">
                                            <div className="flex items-center gap-[8px]">
                                                <Skeleton className="size-[26px] shrink-0 rounded-full bg-gray-100" />
                                                <Skeleton
                                                    className={cn('h-4 bg-gray-100', row % 3 === 0 ? 'w-40' : 'w-28')}
                                                />
                                                <Skeleton className="h-3.5 w-12 bg-gray-100" />
                                            </div>
                                        </td>
                                        <td className="py-3.5 px-3 md:px-5">
                                            <Skeleton className={cn('h-3.5 w-24', BAR)} />
                                        </td>
                                        <td className="py-3.5 px-3 md:px-5">
                                            <Skeleton className={cn('h-3.5', BAR, row % 2 === 0 ? 'w-24' : 'w-20')} />
                                        </td>
                                        <td className="py-3.5 px-3 md:px-5">
                                            <Skeleton className={cn('h-3.5', BAR, row % 2 === 0 ? 'w-28' : 'w-36')} />
                                        </td>
                                        <td className="py-3.5 px-3 md:px-5">
                                            <div className="flex flex-col gap-1.5">
                                                <Skeleton className={cn('h-3.5 w-16', BAR)} />
                                                <Skeleton className={cn('h-2.5 w-10', BAR)} />
                                            </div>
                                        </td>
                                        <td className="py-3.5 px-3 md:px-5">
                                            <Skeleton className={cn('ml-auto h-3.5 w-16', BAR)} />
                                        </td>
                                        <td className="py-3.5 pl-3 md:pl-5 pr-4 md:pr-8">
                                            <Skeleton className="ml-auto size-8 rounded-full bg-gray-100" />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
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
