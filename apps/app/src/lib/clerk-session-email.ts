import 'server-only';

import { auth, currentUser } from '@clerk/nextjs/server';

type Session = Awaited<ReturnType<typeof auth>>;

/**
 * The email that identifies the caller to cloudrun-usage.
 *
 * It is the ONLY input to account aliasing there (migrated users resolve to
 * their busiest Clerk account by shared email), so it must come from Clerk and
 * never from the request body. Two Clerk sources are accepted:
 *
 * 1. a session-token claim (`email` / `primary_email` / `primaryEmail`), when
 *    the Clerk instance's session template includes one;
 * 2. otherwise the user's primary address from the Backend API, and only if
 *    Clerk marks it verified.
 *
 * Sessions with neither (wallet sign-in) get no email and resolve to their own
 * Clerk id. Backend lookups are cached per user for a few minutes so the
 * dashboard's RPC fan-out does not hit Clerk on every call.
 */

const BACKEND_EMAIL_TTL_MS = 5 * 60_000;
const backendEmailCache = new Map<string, { email: string | null; expiresAt: number }>();

export function getSessionClaimEmail(session: Session): string | undefined {
    const claims = session.sessionClaims as Record<string, unknown> | null | undefined;
    const raw = claims?.email ?? claims?.primary_email ?? claims?.primaryEmail;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** Clerk's verified primary address for the current user, or undefined. Uncached. */
export async function fetchVerifiedPrimaryEmail(): Promise<{ email?: string; fullName?: string; ok: boolean }> {
    const user = await currentUser().catch(() => null);
    if (!user) return { ok: false };
    const primary = user.primaryEmailAddress;
    const email = primary?.verification?.status === 'verified' ? primary.emailAddress?.trim() || undefined : undefined;
    const fullName = user.fullName?.trim() || undefined;
    return { ok: true, ...(email ? { email } : {}), ...(fullName ? { fullName } : {}) };
}

export async function resolveVerifiedSessionEmail(session: Session): Promise<string | undefined> {
    const fromClaims = getSessionClaimEmail(session);
    if (fromClaims) return fromClaims;

    const userId = session.userId;
    if (!userId) return undefined;

    const cached = backendEmailCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.email ?? undefined;

    const profile = await fetchVerifiedPrimaryEmail();
    // Only cache a Clerk answer. A transient failure must not pin "no email"
    // for the TTL, which would silently drop aliasing for a migrated user.
    if (profile.ok) {
        backendEmailCache.set(userId, { email: profile.email ?? null, expiresAt: Date.now() + BACKEND_EMAIL_TTL_MS });
    }
    return profile.email;
}
