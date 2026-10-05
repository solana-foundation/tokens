export interface ExternalCallOutcome {
    ok: boolean;
    status: number | null;
}

export async function withExternalTiming<T>(
    provider: string,
    url: string,
    fn: () => Promise<T>,
    deriveOutcome?: (result: T) => ExternalCallOutcome,
): Promise<T> {
    const started = Date.now();
    let endpoint = url;
    try {
        endpoint = new URL(url).pathname.replace(/\/+$/, '') || '/';
    } catch {
        endpoint = url.slice(0, 100);
    }
    try {
        const result = await fn();
        const outcome = deriveOutcome
            ? deriveOutcome(result)
            : result instanceof Response
              ? { ok: result.ok, status: result.status }
              : { ok: true, status: null };
        const { status, ok } = outcome;
        console.log(JSON.stringify({
            event: 'external_call',
            provider,
            endpoint,
            status,
            duration_ms: Date.now() - started,
            ok,
        }));
        return result;
    } catch (err) {
        console.log(JSON.stringify({
            event: 'external_call',
            provider,
            endpoint,
            status: null,
            duration_ms: Date.now() - started,
            ok: false,
            error_tag: err instanceof Error ? err.constructor.name : 'unknown',
        }));
        throw err;
    }
}
