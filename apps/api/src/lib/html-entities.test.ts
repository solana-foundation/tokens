import { describe, expect, test } from 'bun:test';

import { decodeHtmlEntities } from './html-entities';

describe('decodeHtmlEntities', () => {
    test('decodes the entities X emits', () => {
        expect(decodeHtmlEntities('Tom &amp; Jerry &lt;3 &quot;cats&quot; &#39;n&#39; &gt;')).toBe(
            'Tom & Jerry <3 "cats" \'n\' >',
        );
    });

    test('does not double-unescape through &amp;', () => {
        expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
        expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    });

    test('leaves plain text alone', () => {
        expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
    });
});
