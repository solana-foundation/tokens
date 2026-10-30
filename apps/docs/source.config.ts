import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

import { tokensDark, tokensLight } from './src/lib/shiki-theme';

export const docs = defineDocs({
    dir: 'content/docs',
    docs: {
        postprocess: {
            // Lets routes read a page as Markdown (includes expanded) without touching the filesystem.
            includeProcessedMarkdown: true,
        },
    },
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
