'use client';

import { useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { OPEN_SEARCH_EVENT } from './token-search';
import { useSearchVisibility } from './search-visibility-provider';
import { IconCommand, IconK } from 'symbols-react';

function handleSearchClick() {
    // Open the command palette with hero attribution (handled by TokenSearch).
    document.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: { trigger: 'hero' } }));
}

export function HeroSearch() {
    const ref = useRef<HTMLDivElement>(null);
    const { setHeroSearchVisible } = useSearchVisibility();

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const observer = new IntersectionObserver(
            ([entry]) => {
                setHeroSearchVisible(entry.isIntersecting);
            },
            {
                threshold: 0,
                rootMargin: '-80px 0px 0px 0px', // Account for sticky header height
            },
        );

        observer.observe(element);

        return () => {
            observer.unobserve(element);
            // Reset visibility when HeroSearch unmounts (e.g., navigating to token page)
            setHeroSearchVisible(false);
        };
    }, [setHeroSearchVisible]);

    return (
        <div ref={ref} className="mx-auto max-w-[580px] relative group px-4 md:px-0">
            <div className="absolute inset-y-0 left-8 md:left-5 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-text-extra-low group-hover:text-text-low transition-colors" />
            </div>
            <button
                type="button"
                className="w-full bg-white border-2 border-border-medium cursor-pointer rounded-full py-3.5 md:py-4.5 pl-12 md:pl-14 pr-4 md:pr-8 text-left text-text-extra-low hover:border-border-medium transition-[box-shadow,border-color,background-color] motion-reduce:transition-none focus:outline-none ring-none hover:ring-4 ring-border-light/50"
                onClick={handleSearchClick}
            >
                <span className="text-[15px] md:text-[17px]">Search by name, symbol or contract address</span>
            </button>
            <div className="flex items-center gap-1 absolute top-1/2 right-8 md:right-6 -translate-y-1/2">
                <kbd className="bg-gray-100 rounded-sm p-1.5">
                    <IconCommand className="size-3 fill-text-medium" />
                </kbd>
                <kbd className="bg-gray-100 rounded-sm p-1.5">
                    <IconK className="size-3 fill-text-medium" />
                </kbd>
            </div>
        </div>
    );
}
