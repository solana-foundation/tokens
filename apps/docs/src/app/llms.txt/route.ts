import { docsLlms } from '@/lib/source';

export const revalidate = false;

/** Index of every docs page with its `.md` URL, for agents. */
export async function GET() {
    return new Response(await docsLlms.index(), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
