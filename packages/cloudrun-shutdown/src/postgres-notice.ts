import type postgres from 'postgres';

/**
 * `onnotice` for every Cloud Run postgres.js client.
 *
 * postgres.js's default handler is `console.log(notice)`, which prints the
 * notice object across ~10 stdout lines. Cloud Logging turns each line into
 * an entry, and the stdout sink forwards every entry to the Loki pipeline.
 * One stop-word search (`to_tsquery` raising "text-search query contains
 * only stop words" once per scanned row per call site) produced 400k–600k
 * entries in a few minutes, every day, and backed the pipeline up by 40+
 * minutes (2026-10-27). Notices are advisory: drop NOTICE and below, keep
 * WARNING and above as a single line.
 */
const LOGGED_SEVERITIES: ReadonlySet<string> = new Set(['WARNING', 'ERROR', 'FATAL', 'PANIC']);

export function onPostgresNotice(notice: postgres.Notice): void {
    const severity = typeof notice.severity === 'string' ? notice.severity : 'NOTICE';
    if (!LOGGED_SEVERITIES.has(severity)) return;
    const code = typeof notice.code === 'string' ? notice.code : '';
    const message = typeof notice.message === 'string' ? notice.message : '';
    console.warn(`[pg notice] ${severity} ${code} ${message}`.replace(/\s+/g, ' ').trim());
}
