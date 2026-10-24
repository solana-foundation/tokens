import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

import { tokensDark, tokensLight } from './src/lib/shiki-theme';

export const docs = defineDocs({
    dir: 'content/docs',
});

export default defineConfig({
    mdxOptions: {
        rehypeCodeOptions: {
            themes: {
                light: tokensLight,
                dark: tokensDark,
            },
        },
    },
});
