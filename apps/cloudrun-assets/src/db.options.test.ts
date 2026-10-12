import { describe, expect, test } from 'bun:test';

import { buildPostgresOptions } from './db';

describe('buildPostgresOptions', () => {
    test('worker sessions carry lock_timeout and statement_timeout by default', () => {
        const options = buildPostgresOptions({}, 'worker');
        expect(options.max).toBe(8);
        expect(options.connection).toEqual({
            application_name: 'cloudrun-assets-jobs',
            lock_timeout: '30000',
            statement_timeout: '300000',
        });
    });

    test('the API role sets neither timeout', () => {
        const options = buildPostgresOptions({}, 'api');
        expect(options.max).toBe(16);
        expect(options.connection).toEqual({ application_name: 'cloudrun-assets' });
    });

    test('env overrides are honoured and 0 disables a timeout', () => {
        const options = buildPostgresOptions(
            { PG_LOCK_TIMEOUT_MS: '0', PG_STATEMENT_TIMEOUT_MS: '120000', PG_POOL_MAX: '4' },
            'worker',
        );
        expect(options.max).toBe(4);
        expect(options.connection).toEqual({ application_name: 'cloudrun-assets-jobs', statement_timeout: '120000' });
    });

    test('invalid values fall back to the defaults', () => {
        const options = buildPostgresOptions({ PG_LOCK_TIMEOUT_MS: '-5', PG_STATEMENT_TIMEOUT_MS: 'soon' }, 'worker');
        expect(options.connection.lock_timeout).toBe('30000');
        expect(options.connection.statement_timeout).toBe('300000');
    });
});
