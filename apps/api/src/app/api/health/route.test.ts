import { describe, expect, it } from 'bun:test';

import { GET as healthGet } from './route';
import { GET as v1HealthGet } from '../v1/health/route';

async function assertPublicHealth(path: string, handler: (request: Request) => Response): Promise<void> {
    const response = handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const requestId = response.headers.get('x-request-id');
    expect(typeof requestId).toBe('string');
    expect(requestId?.length ?? 0).toBeGreaterThan(0);

    const payload = (await response.json()) as unknown;
    expect(payload).toEqual({ ok: true });
}

describe('public health routes', () => {
    it('serves /api/health with no-store caching and a request id', async () => {
        await assertPublicHealth('/api/health', healthGet);
    });

    it('serves /api/v1/health with no-store caching and a request id', async () => {
        await assertPublicHealth('/api/v1/health', v1HealthGet);
    });

    it('issues a unique x-request-id per call', () => {
        const first = healthGet(new Request('http://localhost/api/health')).headers.get('x-request-id');
        const second = healthGet(new Request('http://localhost/api/health')).headers.get('x-request-id');
        expect(first).toBeTruthy();
        expect(second).toBeTruthy();
        expect(first).not.toBe(second);
    });
});
