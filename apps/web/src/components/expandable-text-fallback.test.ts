import { describe, expect, test } from 'bun:test';

import { createFallbackHtml, stripTags } from './expandable-text-fallback';

describe('stripTags', () => {
    test('removes tag spans and keeps text', () => {
        expect(stripTags('<p>Hi <b>there</b></p>')).toBe('Hi there');
    });

    test('keeps an unclosed trailing < as text', () => {
        expect(stripTags('price < 5')).toBe('price < 5');
    });

    test('nested < inside a tag does not leak a tag prefix', () => {
        expect(stripTags('<scr<x>ipt>alert(1)</script>')).not.toContain('<');
    });
});

describe('createFallbackHtml', () => {
    test('turns block tags into line breaks and drops the rest', () => {
        expect(createFallbackHtml('<p>Hi</p><br/>there')).toBe('Hi<br /><br /><br />there');
    });

    test('escapes what survives tag stripping', () => {
        expect(createFallbackHtml('1 < 2 & "ok"')).toBe('1 &lt; 2 &amp; &quot;ok&quot;');
    });

    test('never emits a raw script tag', () => {
        const out = createFallbackHtml('<scr<x>ipt>alert(1)</script><script>alert(2)</script>');
        expect(out).not.toMatch(/<script/i);
        expect(out).not.toContain('<x');
    });

    test('renders list items with bullets', () => {
        expect(createFallbackHtml('<ul><li>a</li><li>b</li></ul>')).toBe('• a<br />• b<br />');
    });
});
