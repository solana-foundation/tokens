import { inferAddressFamily } from '@tokens/asset-registry/chains';

export function normalizeOptionalText(value: string | undefined | null): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (trimmed === '—') return '';
    if (trimmed === '???') return '';
    return trimmed;
}

export function pickFirstSymbol(...values: Array<string | undefined | null>): string {
    for (const value of values) {
        const cleaned = normalizeOptionalText(value);
        if (!cleaned) continue;
        if (inferAddressFamily(cleaned) !== null) continue;
        return cleaned;
    }
    return '';
}

export function pickFirstDisplayName(...values: Array<string | undefined | null>): string {
    for (const value of values) {
        const cleaned = normalizeOptionalText(value);
        if (!cleaned) continue;
        if (inferAddressFamily(cleaned) !== null) continue;
        return cleaned;
    }
    return '';
}
