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

const INCLUDE_TAG = /^[ \t]*<include>([^<\n]+)<\/include>[ \t]*$/gm;

/**
 * Inline `<include>./file.mdx</include>` blocks (what fumadocs-mdx's remarkInclude
 * does at build time) so the copied Markdown reads like the rendered page.
 * Includes resolve relative to the including file and may nest; a path that
 * escapes the content root or does not exist is left as-is.
 */
async function expandIncludes(source: string, fromDir: string, depth = 0): Promise<string> {
    if (depth > 5) return source;
    const matches = [...source.matchAll(INCLUDE_TAG)];
    if (matches.length === 0) return source;

    let out = '';
    let cursor = 0;
    for (const match of matches) {
        const target = path.resolve(fromDir, match[1]!.trim());
        const contentRoot = path.join(DOCS_ROOT, 'content');
        let replacement = match[0];
        if (target.startsWith(contentRoot + path.sep) && (await fileExists(target))) {
            const included = await readFile(target, 'utf8');
            replacement = (await expandIncludes(included, path.dirname(target), depth + 1)).trim();
        }
        out += source.slice(cursor, match.index) + replacement;
        cursor = match.index! + match[0].length;
    }
    return out + source.slice(cursor);
}

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

    const text = await expandIncludes(await readFile(target, 'utf8'), path.dirname(target));
    return new Response(text, {
        status: 200,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}
