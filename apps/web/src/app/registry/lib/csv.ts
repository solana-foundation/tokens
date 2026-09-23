import type { RegistryRow } from './types';

export const REGISTRY_CSV_COLUMNS: ReadonlyArray<{
    header: string;
    value: (row: RegistryRow) => string | number | null;
}> = [
    { header: 'symbol', value: row => row.symbol },
    { header: 'name', value: row => row.name },
    { header: 'mint_address', value: row => row.mintAddress },
    { header: 'solana_asset_class', value: row => row.solanaClass },
    { header: 'rwa_asset_class', value: row => row.rwaClass },
    { header: 'rwa_asset_value_usd', value: row => row.rwaValueUsd },
    { header: 'allium_asset_class', value: row => row.alliumClass },
    { header: 'allium_asset_value_usd', value: row => row.alliumValueUsd },
    { header: 'coingecko_market_cap_usd', value: row => row.marketCapUsd },
    {
        header: 'token_page_url',
        value: row => (row.hasTokenPage ? `https://tokens.xyz/token/${row.mintAddress}` : null),
    },
];

/** RFC 4180 field escaping: quote when the value contains a comma, quote, or newline; double inner quotes. */
export function escapeCsvField(value: string | number | null | undefined): string {
    if (value == null) return '';
    const text = typeof value === 'number' ? String(value) : value;
    // Neutralise spreadsheet formula injection (=, +, -, @) on user-controlled text such as token names.
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function registryRowsToCsv(rows: ReadonlyArray<RegistryRow>): string {
    const lines = [REGISTRY_CSV_COLUMNS.map(column => escapeCsvField(column.header)).join(',')];
    for (const row of rows) {
        lines.push(REGISTRY_CSV_COLUMNS.map(column => escapeCsvField(column.value(row))).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

export function registryCsvFilename(generatedAt: string): string {
    const parsed = Date.parse(generatedAt);
    const stamp = Number.isNaN(parsed) ? 'latest' : new Date(parsed).toISOString().slice(0, 10);
    return `solana-asset-registry-${stamp}.csv`;
}

/** Browser-only: triggers a download of `content` as `filename`. */
export function downloadTextFile(content: string, filename: string, mimeType = 'text/csv;charset=utf-8'): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}
