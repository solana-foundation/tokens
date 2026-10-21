import 'server-only';

import { auth } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { fetchVerifiedPrimaryEmail, getSessionClaimEmail, resolveVerifiedSessionEmail } from '@/lib/clerk-session-email';
import { callCloudRunUsage, CloudRunCallError } from '@/lib/cloudrun';
import { DASHBOARD_FNS } from '@/lib/dashboard-fns';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
        let email: string | undefined;

        if (fn === 'usersUpsertMe') {
            // The write path always asks Clerk fresh: the verified primary address
            // becomes the account email, and fullName comes along for the profile.
            // A session with no verified email (wallet sign-in) upserts without one.
            const profile = await fetchVerifiedPrimaryEmail();
            email = profile.email ?? getSessionClaimEmail(session);
            if (profile.fullName) args = { ...args, fullName: profile.fullName };
        } else {
            email = await resolveVerifiedSessionEmail(session);
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
