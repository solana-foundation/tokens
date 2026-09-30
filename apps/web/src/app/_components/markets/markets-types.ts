export interface MarketsPaginationState {
    pageIndex: number;
    pageSize: number;
    total: number | undefined;
    visibleCount: number;
    itemLabel: 'markets' | 'tickers' | 'assets';
    isLoading: boolean;
    onPageChange: (pageIndex: number) => void;
    onPageSizeChange: (pageSize: number) => void;
}
