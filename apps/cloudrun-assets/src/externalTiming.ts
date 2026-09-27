export async function withExternalTiming<T>(
    provider: string,
    url: string,
    fn: () => Promise<T>,
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
        const status = result instanceof Response ? result.status : null;
        const ok = result instanceof Response ? result.ok || (result.status >= 300 && result.status < 400) : true;
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
