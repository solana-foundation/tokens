import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NextResponse } from 'next/server';

function toSafeSlugPath(raw: string | null): string {
    const slug = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!slug) return '';

    const parts = slug.split('/').filter(Boolean);
    for (const part of parts) {
        if (part === '.' || part === '..') throw new Error('Invalid slug');
        if (part.includes('\\')) throw new Error('Invalid slug');
    }
    return parts.join('/');
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

const DOCS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

export async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let slugPath: string;
    try {
        slugPath = toSafeSlugPath(url.searchParams.get('slug'));
    } catch {
        return NextResponse.json(
            { error: { _tag: 'BadRequest', message: 'Invalid slug' } },
            { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    const base = path.join(DOCS_ROOT, 'content', 'docs');
    const candidates = slugPath
        ? [path.join(base, `${slugPath}.mdx`), path.join(base, slugPath, 'index.mdx')]
        : [path.join(base, 'index.mdx')];

    const target = (await fileExists(candidates[0]))
        ? candidates[0]
        : (await fileExists(candidates[1] ?? ''))
          ? candidates[1]!
          : null;
    if (!target) {
        return NextResponse.json(
            { error: { _tag: 'NotFound', message: 'Page not found' } },
            { status: 404, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    const text = await readFile(target, 'utf8');
    return new Response(text, {
        status: 200,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}
