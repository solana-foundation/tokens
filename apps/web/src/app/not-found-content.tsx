'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { FloatingMarketFeedPageContext } from '@/components/floating-market-feed-context';
import { SiteFooter } from '@/components/site-footer';
import { Logo } from '@/components/logo';

const TokenAsteroidsGame = dynamic(
    () => import('./assets-api/token-asteroids-modal').then(mod => mod.TokenAsteroidsGame),
    {
        ssr: false,
        loading: () => <TokenAsteroidsGamePlaceholder />,
    },
);

export function NotFoundContent() {
    const [gameOpen, setGameOpen] = useState(true);

    return (
        <main className="min-h-dvh bg-background pt-24 text-text-extra-high">
            <FloatingMarketFeedPageContext displayName="404" suppressFeed />
            <style>{`
                .tokens-floating-market-feed {
                    display: none;
                }
            `}</style>
            <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 px-6 pb-12 md:pt-4">
                <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
                    <div className="inline-flex items-center gap-2 border border-border-light bg-background px-3 py-2 text-[length:var(--text-button-sm)] leading-none font-inter-semibold text-text-low">
                        <Logo width={16} height={16} />
                        Lost in token space
                    </div>
                    <div className="space-y-4">
                        <h1 className="font-diatype-medium text-[clamp(4.5rem,12vw,8rem)] leading-[0.86] tracking-normal text-text-extra-high">
                            404
                        </h1>
                        <p className="mx-auto max-w-[40rem] text-center font-inter text-[length:var(--text-body-xl-size)] leading-[var(--leading-normal)] text-text-medium">
                            This page does not exist, but the Tokens Asteroids field is live. Clear a few waves,
                            then jump back to the pair explorer or the market index.
                        </p>
                    </div>
                    <div className="flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
                        <Link
                            href="/"
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-text-extra-high px-4 text-[length:var(--text-button-md)] leading-none font-inter-semibold text-background transition-[colors,transform] duration-150 hover:bg-text-high active:scale-[0.96]"
                        >
                            <ArrowLeft className="size-4" />
                            Home
                        </Link>
                        <Link
                            href="/dex"
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border-light bg-background px-4 text-[length:var(--text-button-md)] leading-none font-inter-semibold text-text-extra-high transition-[colors,transform] duration-150 hover:bg-background-hover active:scale-[0.96]"
                        >
                            <BookOpen className="size-4" />
                            Dex
                        </Link>
                    </div>
                </div>

                <div className="dark overflow-hidden border border-[#2c2c2d] bg-[#0F0F10]">
                    {gameOpen ? (
                        <TokenAsteroidsGame open={gameOpen} onOpenChange={setGameOpen} />
                    ) : (
                        <div className="flex min-h-[260px] items-center justify-center bg-[#08080A] px-6 text-center">
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center border border-[#2c2c2d] bg-white px-4 text-[length:var(--text-button-md)] leading-none font-inter-semibold text-black transition-transform active:scale-[0.96]"
                                onClick={() => setGameOpen(true)}
                            >
                                Play
                            </button>
                        </div>
                    )}
                </div>
            </section>
            <div className="mx-auto max-w-[1120px] px-6 pb-10">
                <SiteFooter tone="light" />
            </div>
        </main>
    );
}

function TokenAsteroidsGamePlaceholder() {
    return (
        <div className="dark mx-auto w-full max-w-none overflow-hidden border border-[#2c2c2d] bg-[#08080A] p-0">
            <div className="relative aspect-[16/9] max-h-[62dvh] min-h-[260px] w-full overflow-hidden bg-[#0F0F10]">
                <div className="absolute inset-x-3 top-3 flex items-start justify-between sm:inset-x-4 sm:top-4">
                    <div className="h-4 w-20 bg-white/20" />
                    <div className="flex gap-2">
                        <div className="size-9 border border-[#2c2c2d]" />
                        <div className="size-9 border border-[#2c2c2d]" />
                    </div>
                </div>
                <div className="absolute right-3 bottom-3 h-4 w-48 bg-white/20 sm:right-4 sm:bottom-4" />
                <div className="absolute bottom-3 left-3 flex gap-3 sm:bottom-4 sm:left-4">
                    <div className="h-3 w-28 bg-white/15" />
                    <div className="h-3 w-20 bg-white/15" />
                </div>
            </div>
        </div>
    );
}
