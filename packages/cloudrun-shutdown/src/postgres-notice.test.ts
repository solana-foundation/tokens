import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { onPostgresNotice } from './postgres-notice';

describe('onPostgresNotice', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const log = spyOn(console, 'log').mockImplementation(() => {});
    afterEach(() => {
        warn.mockClear();
        log.mockClear();
    });

    it('drops NOTICE-level server messages (the stop-word tsquery notice)', () => {
        onPostgresNotice({
            severity_local: 'NOTICE',
            severity: 'NOTICE',
            code: '00000',
            message: "text-search query contains only stop words or doesn't contain lexemes, ignored",
            file: 'tsquery_cleanup.c',
            routine: 'cleanup_tsquery_stopwords',
        });
        expect(warn).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('drops INFO/LOG/DEBUG and a notice without a severity', () => {
        for (const severity of ['INFO', 'LOG', 'DEBUG']) onPostgresNotice({ severity, message: 'x' });
        onPostgresNotice({ message: 'no severity' });
        expect(warn).not.toHaveBeenCalled();
    });

    it('logs WARNING and above as one compact line', () => {
        onPostgresNotice({ severity: 'WARNING', code: '01000', message: 'something\nmulti-line' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[pg notice] WARNING 01000 something multi-line');
        expect(log).not.toHaveBeenCalled();
    });
});
