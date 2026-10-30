'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@tokens/ui/cn';
import { trackEvent } from '@/lib/posthog-client';
import { TokenSearch } from './token-search';
import { SiteMenu, SiteMenuButton } from './site-menu';
import { useSearchVisibility } from './search-visibility-provider';

const NAV_LINK_CLASS =
    'inline-flex h-10 items-center px-2 text-[length:var(--text-button-lg)] font-semibold leading-none text-text-low transition-colors duration-150 hover:text-text-extra-high focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/** Pages with their own primary search; the global token search would compete with it. */
function shouldHideHeaderSearch(pathname: string): boolean {
    return pathname === '/registry';
}

/** Routes that render a hero search; the header search starts hidden there until the hero reports. */
function hasHeroSearch(pathname: string): boolean {
    return pathname === '/';
}

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
    // Before the hero's IntersectionObserver fires, `isHeroSearchVisible` is null. On the home page
    // assume the hero is in view so the header search doesn't appear and then fade out on load.
    // Routes that don't render the header search at all also keep the wrapper hidden, otherwise a
    // client-side navigation from them to the home page animates the wrapper from visible to hidden
    // while the search mounts inside it.
    const hideHeaderSearch =
        isHeroSearchVisible === true ||
        (!!pathname && (shouldHideHeaderSearch(pathname) || (isHeroSearchVisible === null && hasHeroSearch(pathname))));

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
            {/* Three-column grid with equal side tracks keeps the search centered regardless of link widths. */}
            <div className="mx-auto grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-4">
                <div className="flex min-w-0 items-center">
                    {/* Logo + wordmark; hover or focus opens the site menu (products, resources, legal, socials). */}
                    <SiteMenu />
                </div>

                <div className="flex items-center justify-center">
                    <div
                        className={`transition-[opacity,transform] duration-200 ease-out ${
                            hideHeaderSearch
                                ? 'opacity-0 pointer-events-none translate-y-1'
                                : 'opacity-100 pointer-events-auto translate-y-0'
                        }`}
                    >
                        {pathname && shouldHideHeaderSearch(pathname) ? null : <TokenSearch />}
                    </div>
                </div>

                <div className="flex items-center justify-end justify-self-end">
                    <SiteMenuButton className="sm:hidden" />
                    <nav
                        aria-label="Main navigation"
                        className="hidden items-center justify-end gap-6 sm:flex sm:gap-8"
                    >
                        <a
                            href="https://docs.tokens.xyz"
                            target="_blank"
                            rel="noopener noreferrer"
                            className={NAV_LINK_CLASS}
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
            </div>
        </header>
    );
}
