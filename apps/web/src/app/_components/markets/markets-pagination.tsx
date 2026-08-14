'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@tokens/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tokens/ui/select';

import type { MarketsPaginationState } from './markets-types';

export function MarketsPagination({ state }: { state: MarketsPaginationState }) {
    const { pageIndex, pageSize, total, visibleCount, itemLabel, isLoading, onPageChange, onPageSizeChange } = state;
    const isEmpty = visibleCount === 0;
    const start = isEmpty ? 0 : pageIndex * pageSize + 1;
    const end = isEmpty ? 0 : start + visibleCount - 1;
    const pageCount = total ? Math.ceil(total / pageSize) : 1;
    const canPreviousPage = pageIndex > 0;
    const canNextPage = total ? pageIndex < pageCount - 1 : visibleCount === pageSize;

    return (
        <div className="border-t border-border-light px-8 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-[12px] text-text-low font-sans tabular-nums">
                    Showing <span className="text-text-extra-high">{start}</span>–
                    <span className="text-text-extra-high">{end}</span> of{' '}
                    <span className="text-text-extra-high">
                        {total !== undefined ? total.toLocaleString('en-US') : `${visibleCount.toLocaleString('en-US')}+`}
                    </span>{' '}
                    {itemLabel}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
                    <div className="flex items-center gap-2">
                        <span className="text-[12px] text-text-low font-sans">Per page</span>
                        <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
                            <SelectTrigger className="h-9 w-[88px] border-border-medium bg-white text-text-extra-high font-sans text-[12px] shadow-none focus:ring-border-medium">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[10, 20, 50].map(size => (
                                    <SelectItem key={size} value={String(size)} className="font-sans text-[12px]">
                                        {size}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-9 w-9 border-border-medium bg-white text-text-medium hover:bg-gray-50/60 hover:text-text-extra-high shadow-none"
                            onClick={() => onPageChange(pageIndex - 1)}
                            disabled={!canPreviousPage || isLoading}
                            aria-label="Previous page"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>

                        <div className="text-[12px] text-text-low font-sans tabular-nums">
                            Page <span className="text-text-extra-high">{(pageIndex + 1).toLocaleString('en-US')}</span>
                            {total !== undefined && (
                                <>
                                    {' '}
                                    of <span className="text-text-extra-high">{pageCount.toLocaleString('en-US')}</span>
                                </>
                            )}
                        </div>

                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-9 w-9 border-border-medium bg-white text-text-medium hover:bg-gray-50/60 hover:text-text-extra-high shadow-none"
                            onClick={() => onPageChange(pageIndex + 1)}
                            disabled={!canNextPage || isLoading}
                            aria-label="Next page"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
