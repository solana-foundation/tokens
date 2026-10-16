import * as React from 'react';

import type { ChainKind } from '@tokens/asset-registry/chains';

import { SolanaLogo } from '@/components/icons';

/**
 * Monochrome chain marks (currentColor) for the small chain badge on token
 * logos: the header's main logo and every row of the variants dropdown share
 * the same indicator, so "which chain is this token on" reads the same way
 * everywhere. Simplified glyphs of each chain's brand mark.
 */
export function ChainLogo({ chain, className }: { chain: ChainKind; className?: string }) {
    switch (chain) {
        case 'solana':
            return <SolanaLogo className={className} />;
        case 'ethereum':
            return <EthereumLogo className={className} />;
        case 'base':
            return <BaseLogo className={className} />;
        case 'arbitrum':
            return <ArbitrumLogo className={className} />;
        case 'polygon':
            return <PolygonLogo className={className} />;
        case 'bnb':
            return <BnbLogo className={className} />;
    }
}

function EthereumLogo({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 256 417"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path d="M127.9 0L125.2 9.5v275.7l2.7 2.8 127.9-75.6L127.9 0z" fill="currentColor" />
            <path d="M127.9 0L0 212.4l127.9 75.6V0z" fill="currentColor" fillOpacity="0.6" />
            <path d="M127.9 312.2l-1.6 1.9v98.2l1.6 4.6 128-180.3-128 75.6z" fill="currentColor" />
            <path d="M127.9 416.9v-104.7L0 236.6l127.9 180.3z" fill="currentColor" fillOpacity="0.6" />
        </svg>
    );
}

function BaseLogo({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 111 111"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M54.9 111c30.6 0 55.5-24.9 55.5-55.5S85.5 0 54.9 0C25.9 0 2.1 22.3 0 50.7h73.4v9.6H0C2.1 88.7 25.9 111 54.9 111z"
                fill="currentColor"
            />
        </svg>
    );
}

function ArbitrumLogo({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M12 1.5 3 6.75v10.5L12 22.5l9-5.25V6.75L12 1.5zm0 2.3 7 4.08v8.24l-7 4.08-7-4.08V7.88l7-4.08z"
                fill="currentColor"
            />
            <path
                d="M11.2 6.8h1.6l4.2 10.4h-1.9l-1.1-2.9h-4L8.9 17.2H7L11.2 6.8zm2.2 6-1.4-3.7-1.4 3.7h2.8z"
                fill="currentColor"
            />
        </svg>
    );
}

function PolygonLogo({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 38 33"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M28.7 10.3c-.7-.4-1.6-.4-2.3 0l-5.3 3.1-3.6 2-5.3 3.1c-.7.4-1.6.4-2.3 0l-4.2-2.5c-.7-.4-1.2-1.2-1.2-2v-4.8c0-.8.4-1.6 1.2-2l4.1-2.4c.7-.4 1.6-.4 2.3 0l4.1 2.4c.7.4 1.2 1.2 1.2 2v3.1l3.6-2.1V7c0-.8-.4-1.6-1.2-2L12.2.6c-.7-.4-1.6-.4-2.3 0L2.2 5C1.4 5.4 1 6.2 1 7v8.8c0 .8.4 1.6 1.2 2l7.7 4.4c.7.4 1.6.4 2.3 0l5.3-3.1 3.6-2.1 5.3-3.1c.7-.4 1.6-.4 2.3 0l4.1 2.4c.7.4 1.2 1.2 1.2 2v4.8c0 .8-.4 1.6-1.2 2l-4.1 2.4c-.7.4-1.6.4-2.3 0l-4.1-2.4c-.7-.4-1.2-1.2-1.2-2v-3.1l-3.6 2.1v3.1c0 .8.4 1.6 1.2 2l7.7 4.4c.7.4 1.6.4 2.3 0l7.7-4.4c.7-.4 1.2-1.2 1.2-2v-8.8c0-.8-.4-1.6-1.2-2l-7.8-4.5z"
                fill="currentColor"
            />
        </svg>
    );
}

function BnbLogo({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path
                d="M12 2.4 5.9 8.5l2.3 2.3L12 7l3.8 3.8 2.3-2.3L12 2.4zM3.6 12 5.9 9.7l2.3 2.3-2.3 2.3L3.6 12zm4.6 0L12 8.2l3.8 3.8-3.8 3.8L8.2 12zm7.6 0 2.3-2.3 2.3 2.3-2.3 2.3-2.3-2.3zm-3.8 10-6.1-6.1 2.3-2.3 3.8 3.8 3.8-3.8 2.3 2.3L12 22z"
                fill="currentColor"
            />
        </svg>
    );
}
