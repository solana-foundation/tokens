import { Hono } from 'hono';
import { isValidBearerToken } from '@tokens/cloudrun-shutdown';

import { getLatestByCoinId, InvalidArgsError, type PricesRepo } from './handlers/prices';

export interface ServerDeps {
    repo: PricesRepo;
    /** Current shared bearer, or [current, previous] during a rotation. */
    authToken: string | readonly string[];
}

type QueryHandler = (args: unknown) => Promise<unknown>;

export function createApp(deps: ServerDeps) {
    const app = new Hono();

    const queries: Record<string, QueryHandler> = Object.create(null);
    queries.getLatestByCoinId = args => getLatestByCoinId(deps.repo, args);

    app.get('/health', c => c.json({ ok: true }));

    app.post('/query/:name', async c => {
        if (!isValidBearerToken(c.req.header('authorization'), deps.authToken)) {
            return c.json({ error: 'unauthorized' }, 401);
        }
        const name = c.req.param('name');
        if (!Object.hasOwn(queries, name)) {
            return c.json({ error: `unknown query: ${name}` }, 404);
        }
        const handler = queries[name]!;
        const args: unknown = await c.req.json().catch(() => ({}));
        try {
            return c.json(await handler(args));
        } catch (err) {
            if (err instanceof InvalidArgsError) {
                return c.json({ error: 'invalid_args', message: err.message }, 400);
            }
            console.error(`[cloudrun-prices] handler ${name} threw`, err);
            return c.json({ error: 'handler_error' }, 500);
        }
    });

    return app;
}
