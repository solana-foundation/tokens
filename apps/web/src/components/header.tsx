'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { trackEvent } from '@/lib/posthog-client';
import { TokenSearch } from './token-search';
import { Logo } from './logo';
import { useSearchVisibility } from './search-visibility-provider';

function getHasScrolled(): boolean {
    return window.scrollY > 0;
}

function shouldHideGlobalHeader(pathname: string): boolean {
    // Routes that render their own page-scoped nav and want the global header hidden.
    return (
        pathname === '/assets-api' ||
        pathname.startsWith('/assets-api/') ||
        pathname === '/partners' ||
        pathname.startsWith('/partners/')
    );
}

export function Header() {
    const pathname = usePathname();
    const { isHeroSearchVisible } = useSearchVisibility();
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

    if (pathname && shouldHideGlobalHeader(pathname)) return null;

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
                <div className="flex items-center">
                    <Link
                        href="/"
                        className="flex items-center justify-center group gap-2"
                        onClick={() =>
                            trackEvent('nav_link_clicked', {
                                destination: 'home',
                                link_url: '/',
                                source: 'header',
                            })
                        }
                    >
                        <Logo width={24} height={24} className="" />
                        <span className="text-text-extra-high font-semibold text-2xl">Tokens</span>
                    </Link>
                </div>

                <div className="flex items-center">
                    <div
                        className={`transition-[opacity,transform] duration-200 ease-out ${
                            isHeroSearchVisible
                                ? 'opacity-0 pointer-events-none translate-y-1'
                                : 'opacity-100 pointer-events-auto translate-y-0'
                        }`}
                    >
                        <TokenSearch />
                    </div>
                </div>

                <nav aria-label="Main navigation" className="hidden items-center gap-6 sm:flex sm:gap-8">
                    <Link
                        href="/dex"
                        className="inline-flex h-10 items-center px-2 text-[length:var(--text-button-lg)] font-semibold leading-none text-text-medium transition-colors duration-150 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        onClick={() =>
                            trackEvent('nav_link_clicked', {
                                destination: 'dex',
                                link_url: '/dex',
                                source: 'header',
                            })
                        }
                    >
                        DEX
                    </Link>
                    <a
                        href="https://docs.tokens.xyz"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-10 items-center px-2 text-[length:var(--text-button-lg)] font-semibold leading-none text-text-medium transition-colors duration-150 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        onClick={() =>
                            trackEvent('external_link_clicked', {
                                link_type: 'docs',
                                link_url: 'https://docs.tokens.xyz',
                                source: 'header',
                            })
                        }
                    >
                        Docs
                    </a>
                    <Link
                        href="/assets-api"
                        className="inline-flex h-9 items-center justify-center rounded-full bg-text-extra-high px-3.5 text-[length:var(--text-button-md)] font-semibold leading-none text-background transition-[colors,transform] duration-150 hover:bg-text-high active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        onClick={() =>
                            trackEvent('nav_link_clicked', {
                                destination: 'assets_api',
                                link_url: '/assets-api',
                                source: 'header',
                            })
                        }
                    >
                        Assets API
                    </Link>
                </nav>
            </div>
        </header>
    );
}
