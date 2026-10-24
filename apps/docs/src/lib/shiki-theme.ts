/**
 * Syntax palette for docs code blocks, modelled on the Rex docs
 * (superlogical.com/rex/docs). Plain identifiers and punctuation stay in the
 * ink colour; only meaningful token classes are tinted.
 */
interface ThemeRule {
    scope?: string[];
    settings: { foreground?: string; background?: string };
}

/** Structural subset of Shiki's `ThemeRegistrationRaw`. */
interface ShikiTheme {
    name: string;
    type: 'light' | 'dark';
    colors: Record<string, string>;
    settings: ThemeRule[];
}

interface Palette {
    ink: string;
    keyword: string;
    string: string;
    property: string;
    func: string;
    operator: string;
    comment: string;
    variable: string;
}

function createTheme(name: string, type: 'light' | 'dark', p: Palette): ShikiTheme {
    return {
        name,
        type,
        colors: {
            'editor.foreground': p.ink,
            'editor.background': '#00000000',
        },
        settings: [
            { settings: { foreground: p.ink, background: '#00000000' } },
            {
                scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
                settings: { foreground: p.comment },
            },
            {
                scope: [
                    'keyword',
                    'keyword.control',
                    'storage',
                    'storage.type',
                    'storage.modifier',
                    'constant.language',
                    'variable.language',
                ],
                settings: { foreground: p.keyword },
            },
            {
                scope: ['keyword.operator', 'punctuation.separator.key-value', 'constant.other.option'],
                settings: { foreground: p.operator },
            },
            {
                scope: [
                    'string',
                    'string.quoted',
                    'string.template',
                    'punctuation.definition.string',
                    'constant.numeric',
                    'constant.character',
                ],
                settings: { foreground: p.string },
            },
            {
                scope: [
                    'variable.other.property',
                    'variable.other.object.property',
                    'support.type.property-name',
                    'meta.object-literal.key',
                    'entity.name.tag',
                    'entity.other.attribute-name',
                    'entity.name.type',
                    'support.type',
                    'support.class',
                    'entity.name.class',
                ],
                settings: { foreground: p.property },
            },
            {
                scope: [
                    'entity.name.function',
                    'support.function',
                    'meta.function-call entity.name.function',
                    'entity.name.command',
                    'support.function.builtin',
                ],
                settings: { foreground: p.func },
            },
            {
                scope: [
                    'variable.other.normal',
                    'variable.other.special',
                    'variable.other.positional',
                    'punctuation.definition.variable',
                    'variable.parameter',
                ],
                settings: { foreground: p.variable },
            },
        ],
    };
}

export const tokensLight = createTheme('tokens-light', 'light', {
    ink: '#181d16',
    keyword: '#e8033e',
    string: '#af26ff',
    property: '#5a60fe',
    func: '#ca4c04',
    operator: '#a6667a',
    comment: '#61685e',
    variable: '#d801ad',
});

export const tokensDark = createTheme('tokens-dark', 'dark', {
    ink: '#ececea',
    keyword: '#ff6e81',
    string: '#c989fe',
    property: '#8f9fff',
    func: '#ff8b5d',
    operator: '#c0909c',
    comment: '#92998f',
    variable: '#ff71d6',
});
