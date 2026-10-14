'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { SiteMenu } from '@/components/site-menu';
import { DOCS_HREF } from './constants';

function getHasScrolled(): boolean {
    return window.scrollY > 0;
}

export function PartnersNav() {
    const [hasScrolled, setHasScrolled] = useState(false);

    useEffect(() => {
        function handleScroll() {
            const nextHasScrolled = getHasScrolled();
            setHasScrolled(prevHasScrolled =>
                prevHasScrolled === nextHasScrolled ? prevHasScrolled : nextHasScrolled,
            );
        }

        handleScroll();
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    return (
        <header
            className={cn(
                'fixed inset-x-0 top-0 z-40 border-b transition-colors duration-200',
                hasScrolled
                    ? 'bg-background/70 backdrop-blur-sm border-border-light/70'
                    : 'bg-transparent border-transparent',
            )}
        >
            <div className="mx-auto flex items-center justify-between gap-4 px-6 py-4">
                <SiteMenu />
                <nav aria-label="Partners navigation" className="hidden items-center gap-6 sm:flex sm:gap-8">
                    <a
                        href={DOCS_HREF}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-10 items-center px-2 text-[length:var(--text-button-lg)] leading-none font-semibold text-text-medium transition-colors duration-150 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                        Docs
                    </a>
                    <Link
                        href="/assets-api"
                        className="inline-flex h-9 items-center justify-center rounded-full bg-text-extra-high px-3.5 text-[length:var(--text-button-md)] leading-none font-semibold text-background transition-[colors,transform] duration-150 hover:bg-text-high active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                        Assets API
                    </Link>
                </nav>
            </div>
        </header>
    );
}
