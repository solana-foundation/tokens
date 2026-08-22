'use client';

import { useEffect, useState } from 'react';

/** Mirrors the API's `check-slug` response plus local UI-only states. */
export type SlugAvailability =
    | { state: 'idle' }
    | { state: 'checking' }
    | { state: 'available' }
    | { state: 'unavailable'; reason: 'invalid' | 'reserved' | 'taken' }
    | { state: 'error' };

const REASON_COPY: Record<'invalid' | 'reserved' | 'taken', string> = {
    invalid: 'Must start with a letter, then 3–63 lowercase letters, numbers, or hyphens.',
    reserved: 'This slug is reserved for Solana Foundation lists or API routes.',
    taken: 'Already in use — delete that list first, or pick another slug.',
};

export function slugAvailabilityMessage(availability: SlugAvailability): string | null {
    if (availability.state === 'unavailable') return REASON_COPY[availability.reason];
    if (availability.state === 'error') return 'Could not check availability — create will validate it.';
    return null;
}

/**
 * Debounced live availability check against `/api/v2/lists/check-slug`, so a
 * taken slug turns the field red while typing instead of at submit time.
 *
 * `ignore` short-circuits to `available` for a value that is already the
 * caller's own (the current slug when renaming) — the API would report it as
 * `taken` by itself. Network failures resolve to `error`, never to a hard block:
 * the create/rename request is the authority.
 */
export function useSlugAvailability(
    slug: string,
    options: {
        enabled?: boolean;
        ignore?: string;
        fetcher: (path: string) => Promise<Response>;
    },
): SlugAvailability {
    const { enabled = true, ignore, fetcher } = options;
    const value = slug.trim().toLowerCase();
    const [availability, setAvailability] = useState<SlugAvailability>({ state: 'idle' });

    useEffect(() => {
        if (!enabled || !value) {
            setAvailability({ state: 'idle' });
            return;
        }
        if (ignore && value === ignore.trim().toLowerCase()) {
            setAvailability({ state: 'available' });
            return;
        }

        let cancelled = false;
        setAvailability({ state: 'checking' });
        const handle = setTimeout(() => {
            void fetcher(`/api/v2/lists/check-slug?slug=${encodeURIComponent(value)}`)
                .then(async res => {
                    if (!res.ok) throw new Error(`check failed (HTTP ${res.status})`);
                    return (await res.json()) as {
                        available: boolean;
                        reason?: 'invalid' | 'reserved' | 'taken';
                    };
                })
                .then(body => {
                    if (cancelled) return;
                    if (body.available) {
                        setAvailability({ state: 'available' });
                        return;
                    }
                    setAvailability({ state: 'unavailable', reason: body.reason ?? 'taken' });
                })
                .catch(() => {
                    if (!cancelled) setAvailability({ state: 'error' });
                });
        }, 300);

        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [value, enabled, ignore, fetcher]);

    return availability;
}
