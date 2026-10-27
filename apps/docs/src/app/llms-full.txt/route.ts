import { docsLlms } from '@/lib/source';

export const revalidate = false;

/** Every docs page as one Markdown document, for agents. */
export async function GET() {
    return new Response(await docsLlms.full(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
