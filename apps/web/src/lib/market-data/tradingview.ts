import 'server-only';

import { Effect } from 'effect';
import { fetchJsonWithRetry } from '@tokens/effect';

const SCANNER_BASE_URL = 'https://scanner.tradingview.com';

/**
 * The scanner endpoint is the one the tradingview.com screeners call. It is not
 * a documented product API, so it rejects requests that don't look like they
 * came from the site and it can change shape without notice — every consumer
 * here reads columns by name and tolerates missing ones.
 */
const SCANNER_HEADERS: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/',
};

export interface ScannerFilter {
    left: string;
    operation: string;
    /** `in_range` takes a list; every other operation takes a scalar. */
    right: string | number | readonly (string | number)[];
}

export interface ScannerQuery {
    /** Scanner market segment, e.g. `coin`, `america`, `global`. */
    market: string;
    columns: readonly string[];
    filter?: readonly ScannerFilter[];
    /** Fetch an explicit ticker list instead of screening the whole market. */
    tickers?: readonly string[];
    sort?: { sortBy: string; sortOrder: 'asc' | 'desc' };
    range?: readonly [number, number];
}

export interface ScannerRow {
    /** Fully qualified ticker, e.g. `NASDAQ:NVDA`. */
    ticker: string;
    values: Record<string, unknown>;
}

export interface ScannerResult {
    totalCount: number;
    rows: ScannerRow[];
}

interface RawScannerResponse {
    totalCount?: unknown;
    data?: unknown;
}

function buildBody(query: ScannerQuery): string {
    const body: Record<string, unknown> = {
        columns: [...query.columns],
        options: { lang: 'en' },
    };

    if (query.tickers && query.tickers.length > 0) {
        body.symbols = { tickers: [...query.tickers] };
    }
    if (query.filter && query.filter.length > 0) {
        body.filter = [...query.filter];
    }
    if (query.sort) {
        body.sort = query.sort;
    }
    if (query.range) {
        body.range = [...query.range];
    }

    return JSON.stringify(body);
}

/**
 * Zips the positional `d` array back onto the column names that were requested.
 * Rows shorter than the column list are padded with `undefined` rather than
 * dropped, because the scanner omits trailing nulls for some markets.
 */
function toRow(raw: unknown, columns: readonly string[]): ScannerRow | null {
    if (typeof raw !== 'object' || raw === null) return null;

    const record = raw as { s?: unknown; d?: unknown };
    const cells: unknown[] = Array.isArray(record.d) ? record.d : [];
    if (typeof record.s !== 'string' || cells.length === 0) return null;

    const values: Record<string, unknown> = {};
    columns.forEach((column, index) => {
        values[column] = cells[index];
    });

    return { ticker: record.s, values };
}

export async function runScannerQuery(query: ScannerQuery): Promise<ScannerResult> {
    const url = `${SCANNER_BASE_URL}/${query.market}/scan`;

    const payload = await Effect.runPromise(
        fetchJsonWithRetry<RawScannerResponse>({
            url,
            service: 'tradingview',
            init: {
                method: 'POST',
                headers: SCANNER_HEADERS,
                body: buildBody(query),
                cache: 'no-store',
            },
            maxRetries: 2,
        }),
    );

    const data = Array.isArray(payload.data) ? payload.data : [];
    const rows = data
        .map(item => toRow(item, query.columns))
        .filter((row): row is ScannerRow => row !== null);

    return {
        totalCount: typeof payload.totalCount === 'number' ? payload.totalCount : rows.length,
        rows,
    };
}

/** Strips the exchange prefix: `NASDAQ:NVDA` -> `NVDA`. */
export function bareSymbol(ticker: string): string {
    const separator = ticker.indexOf(':');
    return separator === -1 ? ticker : ticker.slice(separator + 1);
}
