/**
 * Tolerant parser for "a list of mints" pasted or uploaded by a curator.
 * (Twin of apps/admin/src/app/lists/parse-mints-csv.ts — the two Next apps
 * share no utility package; keep them in sync.)
 *
 * Accepts, in order of how people actually produce these files:
 * - a CSV with a header (`mint`/`address`/`token_address`, optional
 *   `note`/`memo`/`comment`/`label`), comma, tab, or semicolon delimited,
 *   with or without quotes;
 * - a headerless CSV where the mint is whichever cell looks like one and the
 *   next non-empty cell (if any) is the note;
 * - a bare list: one mint per line, or mints separated by commas/whitespace.
 *
 * Row order is preserved — the import path ranks net-new members in the order
 * received, so the CSV's order is the list's order. Duplicates keep the first
 * occurrence.
 */

export interface ParsedMemberRow {
    mint: string;
    note: string | null;
    /** 1-based source line, for pointing at problems. */
    line: number;
}

export interface ParsedMintsCsv {
    rows: ParsedMemberRow[];
    /** Non-empty lines with no mint-shaped cell. */
    invalid: Array<{ line: number; value: string }>;
    /** Rows dropped because their mint already appeared earlier. */
    duplicates: number;
    headerDetected: boolean;
}

const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT_HEADERS = new Set([
    'mint',
    'address',
    'token',
    'token_address',
    'tokenaddress',
    'mint_address',
    'mintaddress',
]);
const NOTE_HEADERS = new Set(['note', 'notes', 'memo', 'comment', 'comments', 'label', 'description', 'reason']);

function normalizeHeader(cell: string): string {
    return cell
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function detectDelimiter(lines: string[]): ',' | '\t' | ';' {
    const sample = lines.slice(0, 20);
    const score = (delimiter: string) => sample.reduce((n, line) => n + (line.split(delimiter).length - 1), 0);
    const tab = score('\t');
    const semi = score(';');
    const comma = score(',');
    if (tab >= semi && tab >= comma && tab > 0) return '\t';
    if (semi > comma) return ';';
    return ',';
}

/** RFC-4180-ish single-line split: honours quotes and doubled-quote escapes. */
function splitCsvLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    current += '"';
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === delimiter) {
            cells.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    cells.push(current);
    return cells.map(cell => cell.trim());
}

export function parseMintsCsv(text: string): ParsedMintsCsv {
    const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
    const lines = rawLines.map((line, index) => ({ line: index + 1, text: line.trim() })).filter(l => l.text !== '');

    const result: ParsedMintsCsv = { rows: [], invalid: [], duplicates: 0, headerDetected: false };
    if (lines.length === 0) return result;

    const delimiter = detectDelimiter(lines.map(l => l.text));
    let mintCol: number | null = null;
    let noteCol: number | null = null;

    // Header sniff: only when the first row has no mint in it and names a mint column.
    const firstCells = splitCsvLine(lines[0]!.text, delimiter);
    if (!firstCells.some(cell => MINT_REGEX.test(cell))) {
        const headers = firstCells.map(normalizeHeader);
        const mintIndex = headers.findIndex(h => MINT_HEADERS.has(h));
        if (mintIndex !== -1) {
            result.headerDetected = true;
            mintCol = mintIndex;
            const noteIndex = headers.findIndex(h => NOTE_HEADERS.has(h));
            noteCol = noteIndex === -1 ? null : noteIndex;
        }
    }

    const seen = new Set<string>();
    const body = result.headerDetected ? lines.slice(1) : lines;

    for (const { line, text } of body) {
        const cells = splitCsvLine(text, delimiter);

        let mint: string | null = null;
        let note: string | null = null;

        if (mintCol !== null) {
            const candidate = cells[mintCol] ?? '';
            if (MINT_REGEX.test(candidate)) mint = candidate;
            if (noteCol !== null) note = cells[noteCol]?.trim() || null;
        } else {
            // A bare line may pack several mints separated by spaces/commas. Only
            // when more than one mint shows up do we treat it that way — otherwise
            // a spaced note like "USD Coin" would be torn apart.
            const packed = cells.flatMap(cell => cell.split(/\s+/)).filter(token => MINT_REGEX.test(token));
            if (packed.length > 1) {
                for (const m of packed) {
                    if (seen.has(m)) {
                        result.duplicates += 1;
                        continue;
                    }
                    seen.add(m);
                    result.rows.push({ mint: m, note: null, line });
                }
                continue;
            }
            const mintIndex = cells.findIndex(cell => MINT_REGEX.test(cell.trim()));
            if (mintIndex !== -1) {
                mint = cells[mintIndex]!.trim();
                note = cells.find((cell, i) => i !== mintIndex && cell !== '')?.trim() || null;
            } else if (packed.length === 1) {
                // Single mint with stray surrounding tokens, e.g. "1. <mint>".
                mint = packed[0]!;
            }
        }

        if (!mint) {
            result.invalid.push({ line, value: text.length > 80 ? `${text.slice(0, 77)}…` : text });
            continue;
        }
        if (seen.has(mint)) {
            result.duplicates += 1;
            continue;
        }
        seen.add(mint);
        result.rows.push({ mint, note, line });
    }

    return result;
}
