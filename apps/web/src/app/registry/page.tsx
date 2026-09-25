import type { Metadata } from 'next';
import { Suspense } from 'react';
import { connection } from 'next/server';

import { Skeleton } from '@tokens/ui/skeleton';
import { SiteFooter } from '@/components/site-footer';
import { fetchRegistry } from './lib/fetch-registry';
import { RegistryTable } from './registry-table';

export const metadata: Metadata = {
    title: 'Asset Registry | Tokens',
    description: 'Canonical registry of Solana assets with internal, RWA.xyz, and Allium classifications.',
    robots: { index: false, follow: false },
};

export default function RegistryPage() {
    return (
        <main className="min-h-dvh bg-white relative overflow-x-hidden">
            <div className="absolute inset-x-0 top-0 h-[600px] bg-linear-to-b from-gray-1400/5 to-transparent pointer-events-none" />
            <section className="relative mx-auto max-w-7xl px-6 pt-28 mt-12 pb-10">
                <div className="mx-auto max-w-4xl text-center text-pretty">
                    <h1 className="text-balance text-[44px] leading-[1.02] md:text-[54px] font-medium text-text-extra-high">
                        Asset Registry
                    </h1>
                    <p className="mx-auto mt-5 max-w-2xl text-[length:var(--text-body-lg-size)] leading-[var(--leading-normal)] text-text-medium">
                        Canonical Solana assets with internal, RWA.xyz, and Allium classifications and values.
                    </p>
                </div>
            </section>

            <Suspense fallback={<RegistryFallback />}>
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
 * `connection()` keeps the registry fetch out of the build-time prerender so
 * the static shell never depends on SOLANA_DATA_API_KEY or the upstream
 * being reachable; the hourly `use cache` inside fetchRegistry still applies
 * across requests.
 */
async function RegistryLoader() {
    await connection();
    try {
        const data = await fetchRegistry();
        return (
            <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
                <RegistryTable data={data} />
            </section>
        );
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'asset_registry_fetch_failed',
                message: error instanceof Error ? error.message : String(error),
            }),
        );
        return <RegistryUnavailable />;
    }
}

function RegistryUnavailable() {
    return (
        <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
            <div className="bg-white rounded-[24px] md:rounded-[32px] border border-border-light shadow-[0_8px_40px_rgba(0,0,0,0.03)] p-6 md:p-12 text-center">
                <p className="text-text-low text-[14px] md:text-[16px]">Registry data is temporarily unavailable</p>
                <p className="text-text-extra-low text-[12px] md:text-[14px] mt-2">Please try again in a few minutes.</p>
            </div>
        </section>
    );
}

function RegistryFallback() {
    return (
        <section className="relative mx-auto max-w-7xl px-4 md:px-6 pb-12 md:pb-24">
            <Skeleton className="h-10 w-full max-w-[360px] rounded-full bg-gray-50" />
            <Skeleton className="mt-4 h-[560px] w-full rounded-[24px] bg-gray-50" />
        </section>
    );
}
