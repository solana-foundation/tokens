import { formatLargeNumber } from '@/lib/format';
import type { RegistryRow } from './types';

/**
 * Pure filter model for the registry table: field catalog, operators, value
 * parsing/formatting, the row predicate, and the URL codec. No React here so
 * every branch is unit-testable.
 */

export type CategoryFieldId = 'solanaClass' | 'rwaClass' | 'alliumClass' | 'hasTokenPage';
export type UsdFieldId = 'valueUsd' | 'alliumValueUsd' | 'rwaValueUsd' | 'marketCapUsd';
export type FilterFieldId = CategoryFieldId | UsdFieldId;

export type CategoryOp = 'is' | 'is_not';
export type UsdOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type FilterOp = CategoryOp | UsdOp;

export interface RegistryFilter {
    field: FilterFieldId;
    op: FilterOp;
    /** Category value (string) or USD amount (number). */
    value: string | number;
}

interface FieldBase {
    id: FilterFieldId;
    label: string;
    /** Extra words the palette should match on; the label is always matched. */
    synonyms: readonly string[];
}

export interface CategoryField extends FieldBase {
    id: CategoryFieldId;
    kind: 'category';
    read: (row: RegistryRow) => string | null;
}

export interface UsdField extends FieldBase {
    id: UsdFieldId;
    kind: 'usd';
    read: (row: RegistryRow) => number | null;
}

export type FilterField = CategoryField | UsdField;

export const FILTER_FIELDS: readonly FilterField[] = [
    {
        id: 'solanaClass',
        kind: 'category',
        label: 'Asset class',
        synonyms: ['internal', 'category', 'type', 'solana'],
        read: row => row.solanaClass,
    },
    {
        id: 'rwaClass',
        kind: 'category',
        label: 'RWA.xyz class',
        synonyms: ['rwa', 'real world'],
        read: row => row.rwaClass,
    },
    {
        id: 'alliumClass',
        kind: 'category',
        label: 'Allium class',
        synonyms: ['allium'],
        read: row => row.alliumClass,
    },
    {
        id: 'hasTokenPage',
        kind: 'category',
        label: 'Listed on tokens.xyz',
        synonyms: ['token page', 'listed', 'known', 'indexed'],
        read: row => (row.hasTokenPage ? 'yes' : 'no'),
    },
    {
        id: 'valueUsd',
        kind: 'usd',
        label: 'Value',
        synonyms: ['coalesced', 'ranking', 'size', 'aum', 'tvl'],
        read: row => row.valueUsd,
    },
    {
        id: 'alliumValueUsd',
        kind: 'usd',
        label: 'Allium value',
        synonyms: ['allium', 'onchain value'],
        read: row => row.alliumValueUsd,
    },
    {
        id: 'rwaValueUsd',
        kind: 'usd',
        label: 'RWA value',
        synonyms: ['rwa', 'real world', 'rwa.xyz'],
        read: row => row.rwaValueUsd,
    },
    {
        id: 'marketCapUsd',
        kind: 'usd',
        label: 'Market cap',
        synonyms: ['mcap', 'coingecko', 'cap'],
        read: row => row.marketCapUsd,
    },
];

const FIELD_BY_ID = new Map<string, FilterField>(FILTER_FIELDS.map(field => [field.id, field]));

export function getFilterField(id: string): FilterField | null {
    return FIELD_BY_ID.get(id) ?? null;
}

/** Fixed option list for the boolean-ish category field; other fields derive options from the data. */
export const HAS_TOKEN_PAGE_OPTIONS: readonly string[] = ['yes', 'no'];

export const CATEGORY_OPS: ReadonlyArray<{ value: CategoryOp; label: string; keywords: readonly string[] }> = [
    { value: 'is', label: 'is', keywords: ['=', 'eq', 'equals', 'in'] },
    { value: 'is_not', label: 'is not', keywords: ['!=', 'not', 'except', 'excluding'] },
];

export const USD_OPS: ReadonlyArray<{ value: UsdOp; symbol: string; label: string; keywords: readonly string[] }> = [
    { value: 'gt', symbol: '>', label: 'greater than', keywords: ['>', 'gt', 'more', 'above', 'over'] },
    { value: 'lt', symbol: '<', label: 'less than', keywords: ['<', 'lt', 'under', 'below', 'smaller'] },
    { value: 'gte', symbol: '≥', label: 'greater than or equal', keywords: ['>=', 'gte', 'at least', 'minimum'] },
    { value: 'lte', symbol: '≤', label: 'less than or equal', keywords: ['<=', 'lte', 'at most', 'maximum'] },
    { value: 'eq', symbol: '=', label: 'equal to', keywords: ['=', '==', 'eq', 'exactly', 'is'] },
];

/** Single keystrokes that pick a USD operator instantly in the op stage. */
export const USD_OP_QUICK_KEYS: Readonly<Record<string, UsdOp>> = { '>': 'gt', '<': 'lt', '=': 'eq' };

const CATEGORY_OP_SET = new Set<string>(CATEGORY_OPS.map(op => op.value));
const USD_OP_SET = new Set<string>(USD_OPS.map(op => op.value));

export function opSymbol(op: FilterOp): string {
    if (op === 'is') return 'is';
    if (op === 'is_not') return 'is not';
    return USD_OPS.find(candidate => candidate.value === op)?.symbol ?? op;
}

/**
 * Human USD input: "5m", "$1.5b", "200,000", "2bn", "0.5t". Returns null when
 * the text is not a non-negative amount.
 */
export function parseUsdInput(raw: string): number | null {
    const cleaned = raw.trim().toLowerCase().replace(/\$/g, '').replace(/,/g, '').replace(/_/g, '');
    if (!cleaned) return null;
    const match = cleaned.match(/^([0-9]*\.?[0-9]+)\s*(k|m|b|bn|t)?$/);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const suffix = match[2] ?? '';
    const multiplier =
        suffix === 'k'
            ? 1e3
            : suffix === 'm'
              ? 1e6
              : suffix === 'b' || suffix === 'bn'
                ? 1e9
                : suffix === 't'
                  ? 1e12
                  : 1;
    const value = amount * multiplier;
    return Number.isFinite(value) ? value : null;
}

/** Validates + normalizes a candidate; returns an error message instead of a filter on bad input. */
export function buildFilter(input: {
    field: string;
    op: string;
    value: string | number;
}): { filter: RegistryFilter } | { error: string } {
    const field = getFilterField(input.field);
    if (!field) return { error: 'Unknown field' };

    if (field.kind === 'category') {
        if (!CATEGORY_OP_SET.has(input.op)) return { error: 'Unknown condition' };
        const value = String(input.value).trim();
        if (!value) return { error: 'Pick a value' };
        return { filter: { field: field.id, op: input.op as CategoryOp, value } };
    }

    if (!USD_OP_SET.has(input.op)) return { error: 'Unknown condition' };
    const value = typeof input.value === 'number' ? input.value : parseUsdInput(input.value);
    if (value == null || !Number.isFinite(value) || value < 0) {
        return { error: 'Enter an amount like 5m or $1.5b' };
    }
    return { filter: { field: field.id, op: input.op as UsdOp, value } };
}

function formatUsdCompact(value: number): string {
    return formatLargeNumber(value).replace(/\.00([KMBT]?)$/, '$1');
}

/** Human-readable form of one filter, e.g. "Allium value > $5M" or "Asset class is Stocks". */
export function formatFilter(filter: RegistryFilter): string {
    const field = getFilterField(filter.field);
    const label = field?.label ?? filter.field;
    const value = typeof filter.value === 'number' ? formatUsdCompact(filter.value) : filter.value;
    return `${label} ${opSymbol(filter.op)} ${value}`;
}

export function formatFilterValue(filter: RegistryFilter): string {
    return typeof filter.value === 'number' ? formatUsdCompact(filter.value) : filter.value;
}

export function matchesFilter(row: RegistryRow, filter: RegistryFilter): boolean {
    const field = getFilterField(filter.field);
    if (!field) return true;

    if (field.kind === 'category') {
        const actual = field.read(row);
        const equal = actual != null && actual === filter.value;
        return filter.op === 'is_not' ? !equal : equal;
    }

    const actual = field.read(row);
    const expected = typeof filter.value === 'number' ? filter.value : parseUsdInput(String(filter.value));
    if (actual == null || expected == null) return false;
    switch (filter.op) {
        case 'gt':
            return actual > expected;
        case 'gte':
            return actual >= expected;
        case 'lt':
            return actual < expected;
        case 'lte':
            return actual <= expected;
        case 'eq':
            return actual === expected;
        default:
            return true;
    }
}

export function matchesSearch(row: RegistryRow, q: string): boolean {
    const needle = q.toLowerCase().trim();
    if (!needle) return true;
    return (
        row.symbol.toLowerCase().includes(needle) ||
        row.mintAddress.toLowerCase().includes(needle) ||
        (row.name?.toLowerCase().includes(needle) ?? false)
    );
}

export function applyFilters(
    rows: readonly RegistryRow[],
    state: { q: string; filters: readonly RegistryFilter[] },
): RegistryRow[] {
    return rows.filter(row => matchesSearch(row, state.q) && state.filters.every(filter => matchesFilter(row, filter)));
}

// ---- URL codec: `f` = JSON array of compact [field, op, value] tuples ----

export function encodeFilters(filters: readonly RegistryFilter[]): string {
    return JSON.stringify(filters.map(filter => [filter.field, filter.op, filter.value]));
}

/** Fail-closed: garbage → [], unknown fields/ops/values are dropped individually. */
export function decodeFilters(raw: string): RegistryFilter[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const filters: RegistryFilter[] = [];
    for (const tuple of parsed) {
        if (!Array.isArray(tuple) || tuple.length !== 3) continue;
        const [field, op, value] = tuple as unknown[];
        if (typeof field !== 'string' || typeof op !== 'string') continue;
        if (typeof value !== 'string' && typeof value !== 'number') continue;
        const built = buildFilter({ field, op, value });
        if ('filter' in built) filters.push(built.filter);
    }
    return filters;
}

// ---- Sort codec: `sort` = "<columnId>.asc|desc" over the sortable table columns ----

export const SORTABLE_COLUMN_IDS = ['token', 'rwaValueUsd', 'alliumValueUsd', 'marketCapUsd'] as const;
export type SortableColumnId = (typeof SORTABLE_COLUMN_IDS)[number];

export const SORT_COLUMN_LABELS: Readonly<Record<SortableColumnId, string>> = {
    token: 'Token',
    rwaValueUsd: 'RWA value',
    alliumValueUsd: 'Allium value',
    marketCapUsd: 'Market cap',
};

export interface RegistrySort {
    id: SortableColumnId;
    desc: boolean;
}

export function encodeSort(sort: RegistrySort): string {
    return `${sort.id}.${sort.desc ? 'desc' : 'asc'}`;
}

export function decodeSort(raw: string): RegistrySort | null {
    const [id, direction] = raw.split('.');
    if (!id || !(SORTABLE_COLUMN_IDS as readonly string[]).includes(id)) return null;
    if (direction !== 'asc' && direction !== 'desc') return null;
    return { id: id as SortableColumnId, desc: direction === 'desc' };
}
