import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';

import { SiteFooter } from '@/components/site-footer';
import { fetchRegistry } from './lib/fetch-registry';
import type { RegistryData } from './lib/types';
import { RegistryTable } from './registry-table';
import { RegistryTableSkeleton } from './registry-table-skeleton';

export const metadata: Metadata = {
    title: 'Real World Assets Registry | Tokens',
    description: 'Canonical RWA registry list for Assets on Solana.',
    robots: { index: false, follow: false },
};

export default function RegistryPage() {
    return (
        <main className="min-h-dvh bg-white relative overflow-x-hidden">
            <div className="absolute inset-x-0 top-0 h-[600px] bg-linear-to-b from-gray-1400/5 to-transparent pointer-events-none" />
            <section className="relative mx-auto max-w-7xl px-6 pt-28 mt-12 pb-10">
                <div className="mx-auto max-w-4xl text-center text-pretty">
                    <h1 className="text-balance text-[44px] leading-[1.02] md:text-[54px] font-medium text-text-extra-high">
                        Real World Assets Registry
                    </h1>
                    <p className="mx-auto mt-5 max-w-2xl text-[length:var(--text-body-lg-size)] leading-[var(--leading-normal)] text-text-medium">
                        Canonical RWA registry list for Assets on Solana.
                    </p>
                </div>
            </section>

            <Suspense fallback={<RegistryTableSkeleton />}>
                <RegistryLoader />
            </Suspense>

            <section className="border-t border-gray-1400/10">
                <div className="mx-auto max-w-[1120px] px-6 pb-10">
                    <SiteFooter tone="light" />
                </div>
            </section>
        </main>
    );
}

/**
 * `connection()` keeps the fetch out of the build-time prerender, so the
 * static shell (heading, skeleton) never depends on the API being reachable.
 * A failed prerender used to bake the "unavailable" panel into the CDN copy
 * of the page, and tokens.xyz served it for hours (2026-10-29). fetchRegistry's
 * `use cache` still serves the rows across requests, and it throws on failure
 * so a failure is never cached: this request shows the panel and the next one
 * retries.
 */
async function RegistryLoader() {
    await connection();
    let data: RegistryData;
    try {
        data = await fetchRegistry();
    } catch (error) {
        // fetchRegistry logs the reason (asset_registry_fetch_failed); in
        // production the message here is Next's generic one, the digest links the two.
        console.error(
            JSON.stringify({
                event: 'asset_registry_unavailable',
                digest: (error as { digest?: unknown } | null)?.digest ?? null,
            }),
        );
        return <RegistryUnavailable />;
    }
    return (
        <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
            <RegistryTable data={data} />
        </section>
    );
}

function RegistryUnavailable() {
    return (
        <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
            <div className="bg-white rounded-[24px] md:rounded-[32px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-6 md:p-12 text-center">
                <p className="text-text-low text-[14px] md:text-[16px]">Registry data is temporarily unavailable</p>
                <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">
                    Please try again in a few minutes.
                </p>
            </div>
        </section>
    );
}
