import 'server-only';

import { createPlaygroundProxy } from '@/lib/playground-proxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const proxy = createPlaygroundProxy('v2');

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
