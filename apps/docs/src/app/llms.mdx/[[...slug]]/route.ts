import { notFound } from 'next/navigation';

import { docsLlms, source } from '@/lib/source';

export const revalidate = false;

/**
 * A page as Markdown, served at `/<slug>.md` through the rewrite in next.config.mjs.
 * Rendered from the compiled content at build time, so it needs no filesystem access.
 */
export async function GET(_request: Request, context: { params: Promise<{ slug?: string[] }> }) {
    const { slug } = await context.params;
    // Drop the trailing `content.md` segment the rewrite appends.
    const slugs = slug?.slice(0, -1) ?? [];
    if (slugs.at(-1) === 'index') slugs.pop();
    const page = source.getPage(slugs);
    if (!page) notFound();

    return new Response(await docsLlms.page(page), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
}

export function generateStaticParams() {
    return source.generateParams().map(item => ({ ...item, slug: [...item.slug, 'content.md'] }));
}
