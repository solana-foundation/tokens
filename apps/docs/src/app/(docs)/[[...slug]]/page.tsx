import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
    DocsBody,
    DocsDescription,
    DocsPage,
    DocsTitle,
    MarkdownCopyButton,
    ViewOptionsPopover,
} from 'fumadocs-ui/layouts/spacious/page';

import { getMDXComponents } from '@/mdx-components';
import { source } from '@/lib/source';

interface PageProps {
    params: Promise<{
        slug?: Array<string>;
    }>;
}

export default async function Page(props: PageProps) {
    const params = await props.params;
    const slug = params.slug ?? [];

    // `/` is redirected to `/v1` in next.config.mjs.
    const page = source.getPage(slug);
    if (!page) notFound();

    const MDX = page.data.body;
    const slugPath = slug.join('/');
    const relativeLink = createRelativeLink(
        source as unknown as Parameters<typeof createRelativeLink>[0],
        page as unknown as Parameters<typeof createRelativeLink>[1],
    );

    const markdownUrl = `/api/page-markdown?slug=${encodeURIComponent(slugPath)}`;

    return (
        <DocsPage toc={page.data.toc} full={page.data.full}>
            <DocsTitle className="text-2xl">{page.data.title}</DocsTitle>
            <DocsDescription className="mb-2 text-base">{page.data.description}</DocsDescription>
            <div className="mb-4 flex flex-row flex-wrap items-center gap-2 border-b pb-6">
                <MarkdownCopyButton markdownUrl={markdownUrl} />
                <ViewOptionsPopover markdownUrl={markdownUrl} />
            </div>
            <DocsBody className="[--tw-prose-size:0.875]">
                <MDX
                    components={getMDXComponents({
                        a: relativeLink,
                    })}
                />
            </DocsBody>
        </DocsPage>
    );
}

export async function generateStaticParams() {
    return source.generateParams();
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
    const params = await props.params;
    const slug = params.slug ?? [];

    // `/` redirects to `/v1`; keep its metadata stable.
    const page = slug.length === 0 ? source.getPage(['v1']) : source.getPage(slug);
    if (!page) notFound();

    return {
        title: page.data.title,
        description: page.data.description,
    };
}
