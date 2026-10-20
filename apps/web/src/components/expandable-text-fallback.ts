export function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

/**
 * Drop `<...>` tag spans in a single pass. This is a readability step only: the result is
 * HTML-escaped by `createFallbackHtml`, which is the actual safety boundary. A trailing `<`
 * that never closes is kept as text so prose like `price < 5` survives.
 */
export function stripTags(text: string): string {
    let out = '';
    let tagStart = -1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (tagStart === -1) {
            if (ch === '<') tagStart = i;
            else out += ch;
        } else if (ch === '>') {
            tagStart = -1;
        }
    }
    if (tagStart !== -1) out += text.slice(tagStart);
    return out;
}

/**
 * Conservative fallback for SSR / before hydration:
 * - drop all tags (keep readability)
 * - preserve basic line breaks from common tags
 * - escape everything that remains
 */
export function createFallbackHtml(text: string): string {
    const withoutTags = stripTags(
        text
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/li>/gi, '\n')
            .replace(/<li[^>]*>/gi, '• '),
    );

    return escapeHtml(withoutTags).replace(/\n/g, '<br />').trim();
}
