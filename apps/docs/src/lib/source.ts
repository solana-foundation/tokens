import { createGetUrl, llms, loader } from 'fumadocs-core/source';
import { lucideIconsPlugin } from 'fumadocs-core/source/plugins/lucide-icons';
import { docs } from 'fumadocs-mdx:collections/server';

export const source = loader({
    baseUrl: '/',
    source: docs.toFumadocsSource(),
    plugins: [lucideIconsPlugin()],
});

/** Markdown renderings of the docs, for the copy button, `.md` URLs and llms.txt. */
export const docsLlms = llms(source, {
    renderPage: async page => `# ${page.data.title}\n\n${page.data.description ?? ''}\n\n${await page.data.getText('processed')}`,
});

const getContentUrl = createGetUrl('/llms.mdx');

/** Public `.md` URL of a page (rewritten to the llms.mdx route in next.config.mjs). */
export function getPageMarkdownUrl(page: { slugs: string[] }): string {
    return `/${page.slugs.join('/')}.md`;
}

/** Internal route the `.md` rewrite points at. */
export function getPageMarkdownRoute(page: { slugs: string[] }): string {
    return getContentUrl([...page.slugs, 'content.md']);
}
