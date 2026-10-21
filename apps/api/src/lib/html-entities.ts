/**
 * Decode the named/numeric entities the X API emits in post text.
 *
 * `&amp;` is decoded last on purpose: decoding it first turns `&amp;lt;` into `&lt;` and then
 * into `<`, so an escaped literal in the source would come out as markup.
 */
export function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}
