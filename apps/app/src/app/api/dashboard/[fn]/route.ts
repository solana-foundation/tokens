import 'server-only';

import { auth, currentUser } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { callCloudRunUsage, CloudRunCallError } from '@/lib/cloudrun';
import { DASHBOARD_FNS } from '@/lib/dashboard-fns';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function getSessionEmail(session: Awaited<ReturnType<typeof auth>>): string | undefined {
    const claims = session.sessionClaims as Record<string, unknown> | null | undefined;
    const raw = claims?.email ?? claims?.primary_email ?? claims?.primaryEmail;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * Identity fields the client must never supply. `email` keys account aliasing
 * on the Cloud Run side; `fullName` is display-only but is Clerk's to set.
 * Both are stripped from every body and, for upsertMe, re-added from Clerk.
 */
const IDENTITY_ARG_KEYS = ['email', 'fullName'] as const;

function stripIdentityArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out = { ...args };
    for (const key of IDENTITY_ARG_KEYS) delete out[key];
    return out;
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ fn: string }> }) {
    const { fn } = await ctx.params;
    const spec = DASHBOARD_FNS[fn];
    if (!spec) {
        return NextResponse.json({ error: { message: `Unknown dashboard function: ${fn}` } }, { status: 404 });
    }

    const session = await auth();
    if (!session.userId) {
        return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: 401 });
    }

    let args: Record<string, unknown>;
    try {
        const body: unknown = await request.json().catch(() => ({}));
        args = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    } catch {
        args = {};
    }
    args = stripIdentityArgs(args);

    try {
        let email = getSessionEmail(session);

        // upsertMe needs the caller's profile, which session claims may lack.
        // Only a Clerk-verified primary address may become the account email;
        // a session with none (wallet sign-in) upserts with no email at all.
        if (fn === 'usersUpsertMe') {
            const user = await currentUser().catch(() => null);
            const primary = user?.primaryEmailAddress;
            const verifiedEmail =
                primary?.verification?.status === 'verified' ? primary.emailAddress?.trim() || undefined : undefined;
            email = verifiedEmail ?? email;
            const fullName = user?.fullName?.trim() || undefined;
            args = {
                ...args,
                ...(fullName ? { fullName } : {}),
            };
        }

        const result = await callCloudRunUsage(spec.kind, fn, args, {
            clerkUserId: session.userId,
            ...(email ? { email } : {}),
        });
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof CloudRunCallError && (error.status === 401 || error.status === 403)) {
            return NextResponse.json({ error: { message: 'Unauthorized' } }, { status: error.status });
        }
        console.error(`[dashboard-proxy] ${fn} failed`, error);
        const message = error instanceof Error ? error.message : 'Dashboard request failed';
        return NextResponse.json({ error: { message } }, { status: 502 });
    }
}
