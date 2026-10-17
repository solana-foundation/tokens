'use client';

import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';

interface SearchVisibilityContextType {
    /** `null` until the hero search has measured itself (or when no hero search is mounted). */
    isHeroSearchVisible: boolean | null;
    setHeroSearchVisible: (visible: boolean | null) => void;
}

const SearchVisibilityContext = createContext<SearchVisibilityContextType | undefined>(undefined);

export function SearchVisibilityProvider({ children }: { children: ReactNode }) {
    // `null` = no measurement yet. Pages without a hero search treat it as "show the header search";
    // the home page treats it as "hero is in view" so the header search doesn't flash before the
    // IntersectionObserver reports.
    const [isHeroSearchVisible, setIsHeroSearchVisible] = useState<boolean | null>(null);

    const setHeroSearchVisible = useCallback((visible: boolean | null) => {
        setIsHeroSearchVisible(visible);
    }, []);

    const value = useMemo(
        () => ({ isHeroSearchVisible, setHeroSearchVisible }),
        [isHeroSearchVisible, setHeroSearchVisible],
    );

    return <SearchVisibilityContext.Provider value={value}>{children}</SearchVisibilityContext.Provider>;
}

export function useSearchVisibility() {
    const context = useContext(SearchVisibilityContext);
    if (context === undefined) {
        throw new Error('useSearchVisibility must be used within a SearchVisibilityProvider');
    }
    return context;
}
