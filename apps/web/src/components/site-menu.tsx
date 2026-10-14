'use client';

import type React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ChevronDown, Github, type LucideIcon } from 'lucide-react';
import { cn } from '@tokens/ui/cn';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@tokens/ui/hover-card';
import { trackEvent } from '@/lib/posthog-client';
import { Logo } from './logo';

/** Assets API: stacked layers, filled; 32-unit grid like the other product icons. */
function AssetsApiIcon({ className }: { className?: string }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className={className}>
            <path
                d="M15.07 5.55L5.75 10.98C4.52 11.7 4.52 13.47 5.75 14.19L15.07 19.62C15.64 19.96 16.36 19.96 16.94 19.62L26.25 14.19C27.48 13.47 27.48 11.7 26.25 10.98L16.94 5.55C16.36 5.21 15.64 5.21 15.07 5.55Z"
                fill="currentColor"
            />
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M7.87 17.58L5.75 18.81C4.52 19.53 4.52 21.3 5.75 22.02L15.07 27.45C15.64 27.79 16.36 27.79 16.94 27.45L26.25 22.02C27.48 21.3 27.48 19.53 26.25 18.81L24.13 17.58L17.87 21.23C16.72 21.9 15.29 21.9 14.13 21.23L7.87 17.58ZM9.71 16.5L15.07 13.38C15.64 13.04 16.36 13.04 16.94 13.38L22.29 16.5L16.94 19.62C16.36 19.96 15.64 19.96 15.07 19.62L9.71 16.5Z"
                fill="currentColor"
            />
        </svg>
    );
}

type MenuIcon = LucideIcon | ((props: { className?: string }) => React.JSX.Element);

interface Product {
    href: string;
    title: string;
    description: string;
    icon: MenuIcon;
    destination: string;
}

/** Explore: a compass, single filled path. Shares the 32-unit grid with the feed widget's icons. */
function ExploreIcon({ className }: { className?: string }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className={className}>
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M4 16C4 9.37 9.37 4 16 4C22.63 4 28 9.37 28 16C28 22.63 22.63 28 16 28C9.37 28 4 22.63 4 16ZM20.62 10.39C21.37 10.15 22.07 10.85 21.83 11.6L20.21 16.61C19.99 17.29 19.12 17.5 18.61 16.99L15.23 13.61C14.72 13.1 14.93 12.23 15.61 12.01L20.62 10.39ZM10.39 20.62C10.15 21.36 10.85 22.07 11.6 21.83L16.61 20.21C17.29 19.99 17.5 19.12 16.99 18.61L13.61 15.23C13.1 14.72 12.23 14.92 12.01 15.61L10.39 20.62Z"
                fill="currentColor"
            />
        </svg>
    );
}

/** Registry: the list glyph the floating feed uses for its activity panel. */
function RegistryIcon({ className }: { className?: string }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className={className}>
            <path
                d="M13.5 11.5H25.5C26.88 11.5 28 10.38 28 9C28 7.62 26.88 6.5 25.5 6.5H13.5C12.12 6.5 11 7.62 11 9C11 10.38 12.12 11.5 13.5 11.5Z"
                fill="currentColor"
            />
            <path
                d="M6.5 6.5C5.12 6.5 4 7.62 4 9C4 10.38 5.12 11.5 6.5 11.5C7.88 11.5 9 10.38 9 9C9 7.62 7.88 6.5 6.5 6.5Z"
                fill="currentColor"
            />
            <path
                d="M6.5 13.5C5.12 13.5 4 14.62 4 16C4 17.38 5.12 18.5 6.5 18.5C7.88 18.5 9 17.38 9 16C9 14.62 7.88 13.5 6.5 13.5Z"
                fill="currentColor"
            />
            <path
                d="M6.5 20.5C5.12 20.5 4 21.62 4 23C4 24.38 5.12 25.5 6.5 25.5C7.88 25.5 9 24.38 9 23C9 21.62 7.88 20.5 6.5 20.5Z"
                fill="currentColor"
            />
            <path
                d="M13.5 18.5H25.5C26.88 18.5 28 17.38 28 16C28 14.62 26.88 13.5 25.5 13.5H13.5C12.12 13.5 11 14.62 11 16C11 17.38 12.12 18.5 13.5 18.5Z"
                fill="currentColor"
            />
            <path
                d="M13.5 25.5H25.5C26.88 25.5 28 24.38 28 23C28 21.62 26.88 20.5 25.5 20.5H13.5C12.12 20.5 11 21.62 11 23C11 24.38 12.12 25.5 13.5 25.5Z"
                fill="currentColor"
            />
        </svg>
    );
}

const PRODUCTS: Product[] = [
    {
        href: '/',
        title: 'Explore',
        description: 'Curated assets on Solana',
        icon: ExploreIcon,
        destination: 'explore',
    },
    {
        href: '/registry',
        title: 'Registry',
        description: 'Canonical RWA registry',
        icon: RegistryIcon,
        destination: 'registry',
    },
];

/** Full-width card below the product tiles; the "Resolve any asset" art from the landing fades in behind it. */
const FEATURED: Product & { image: string } = {
    href: '/assets-api',
    title: 'Assets API',
    description: 'Unified market data and faster path to build', // rendered inline below with a fixed break
    icon: AssetsApiIcon,
    destination: 'assets_api',
    image: '/landing/benefits/03.png',
};

interface MenuLink {
    href: string;
    label: string;
    external?: boolean;
    destination: string;
}

const RESOURCE_LINKS: MenuLink[] = [
    { href: 'https://docs.tokens.xyz', label: 'Docs', external: true, destination: 'docs' },
    { href: '/heatmap', label: 'Heat map', destination: 'heatmap' },
    { href: '/partners', label: 'Partners', destination: 'partners' },
];

const LEGAL_LINKS: MenuLink[] = [
    { href: '/terms', label: 'Terms', destination: 'terms' },
    { href: '/privacy-policy', label: 'Privacy policy', destination: 'privacy' },
];

const SOCIAL_LINKS: Array<MenuLink & { icon: MenuIcon }> = [
    {
        href: 'https://github.com/solana-foundation',
        label: 'GitHub',
        external: true,
        destination: 'github',
        icon: Github,
    },
    { href: 'https://x.com/tokens', label: 'X', external: true, destination: 'x', icon: XIcon },
];

function XIcon({ className }: { className?: string }) {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={className}>
            <path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.59-6.64 7.59H.47l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93Zm-1.29 19.49h2.04L6.49 3.24H4.3l13.31 17.4Z" />
        </svg>
    );
}

function track(destination: string, href: string) {
    trackEvent('nav_link_clicked', { destination, link_url: href, source: 'site_menu' });
}

const COLUMN_LABEL_CLASS = 'text-[12px] font-medium text-white/50';
const COLUMN_LINK_CLASS =
    'block w-fit rounded-sm text-[13px] font-medium text-white hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40';

function ProductTile({ product }: { product: Product }) {
    const Icon = product.icon;
    return (
        <Link
            href={product.href}
            className="group/tile -m-1.5 flex items-center gap-3 rounded-xl p-1.5 hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
            onClick={() => track(product.destination, product.href)}
        >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/10 text-white group-hover/tile:bg-white group-hover/tile:text-gray-1400">
                <Icon className="size-[18px]" aria-hidden="true" />
            </span>
            <span className="min-w-0">
                <span className="block text-[14px] font-semibold leading-tight text-white">{product.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-white/55">{product.description}</span>
            </span>
        </Link>
    );
}

function FeaturedTile({ product }: { product: typeof FEATURED }) {
    const Icon = product.icon;
    return (
        <Link
            href={product.href}
            className="group/feature relative -mx-1.5 flex min-h-28 items-start gap-3 overflow-hidden rounded-xl border border-white/10 p-1.5 hover:bg-white/5 focus-visible:bg-white/5 focus-visible:outline-none"
            onClick={() => track(product.destination, product.href)}
        >
            {/* Landing art, right-aligned, faded out radially so it dissolves under the copy. */}
            <Image
                src={product.image}
                alt=""
                aria-hidden="true"
                width={930}
                height={876}
                sizes="260px"
                className="pointer-events-none absolute -right-10 top-1/2 w-[260px] -translate-y-1/2 opacity-55 saturate-0 transition-[opacity,filter] duration-200 [mask-image:radial-gradient(closest-side_at_56%_48%,black_10%,transparent_100%)] group-hover/feature:opacity-80 group-hover/feature:saturate-150"
            />
            <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-white/10 text-white group-hover/feature:bg-white group-hover/feature:text-gray-1400">
                <Icon className="size-[18px]" aria-hidden="true" />
            </span>
            <span className="relative min-w-0 flex-1">
                <span className="block text-[14px] font-semibold leading-tight text-white">{product.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-white/55">
                    Unified market data and faster
                    <br />
                    path to build
                </span>
            </span>
        </Link>
    );
}

function MenuColumn({ label, links }: { label: string; links: MenuLink[] }) {
    return (
        <div className="flex flex-col gap-2.5">
            <p className={COLUMN_LABEL_CLASS}>{label}</p>
            <ul className="flex flex-col gap-2">
                {links.map(link => (
                    <li key={link.href}>
                        {link.external ? (
                            <a
                                href={link.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={COLUMN_LINK_CLASS}
                                onClick={() => track(link.destination, link.href)}
                            >
                                {link.label}
                            </a>
                        ) : (
                            <Link
                                href={link.href}
                                className={COLUMN_LINK_CLASS}
                                onClick={() => track(link.destination, link.href)}
                            >
                                {link.label}
                            </Link>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/**
 * Logo + wordmark that opens the site menu on hover or focus: product tiles
 * (Assets API as a full-width card, then Explore and Registry), resource links
 * (Docs, Heat map, Partners), legal, socials.
 * Clicking the logo still goes home. Hover-only by design, so it is not
 * rendered on touch layouts; the header keeps Docs and the Assets API CTA there.
 */
interface SiteMenuProps {
    className?: string;
    /** Wordmark next to the logo; the Assets API landing uses its own. */
    label?: string;
    /** Replaces the gradient logo, e.g. the white mark on the dark landing. */
    logo?: React.ReactNode;
    /** `dark` renders the trigger for a dark page; the panel itself is always the dark tooltip surface. */
    tone?: 'light' | 'dark';
}

export function SiteMenu({ className, label = 'Tokens', logo, tone = 'light' }: SiteMenuProps) {
    const isDark = tone === 'dark';
    return (
        <HoverCard openDelay={60} closeDelay={160}>
            <HoverCardTrigger asChild>
                <Link
                    href="/"
                    className={cn(
                        'group flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-extra-high/30 focus-visible:ring-offset-4 focus-visible:ring-offset-background',
                        className,
                    )}
                    aria-haspopup="true"
                    onClick={() =>
                        trackEvent('nav_link_clicked', { destination: 'home', link_url: '/', source: 'header' })
                    }
                >
                    {logo ?? <Logo width={24} height={24} className="" />}
                    <span className={cn('text-2xl font-semibold', isDark ? 'text-white' : 'text-text-extra-high')}>
                        {label}
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            'size-4 transition-transform duration-200 group-data-[state=open]:rotate-180',
                            isDark ? 'text-white/60' : 'text-text-low',
                        )}
                        strokeWidth={2.25}
                    />
                </Link>
            </HoverCardTrigger>
            <HoverCardContent
                align="start"
                sideOffset={12}
                alignOffset={-10}
                className={cn(
                    'w-[440px] overflow-hidden rounded-2xl border p-0 text-[var(--tooltip-text)] shadow-[0_16px_48px_rgba(0,0,0,0.12)]',
                    // On a near-black page the tooltip surface vanishes; step up to charcoal there.
                    isDark ? 'border-white/10 bg-gray-1300' : 'border-border-strong bg-[var(--tooltip-bg)]',
                )}
            >
                <div className="p-5">
                    <p className={COLUMN_LABEL_CLASS}>Products</p>
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3.5">
                        {PRODUCTS.map(product => (
                            <ProductTile key={product.href} product={product} />
                        ))}
                    </div>
                    <div className="mt-5">
                        <FeaturedTile product={FEATURED} />
                    </div>
                </div>

                <div className="h-px bg-white/10" />

                <div className="grid grid-cols-2 gap-4 p-5">
                    <MenuColumn label="Resources" links={RESOURCE_LINKS} />
                    <MenuColumn label="Legal" links={LEGAL_LINKS} />
                </div>

                <div className="h-px bg-white/10" />

                <div className="flex items-end justify-between px-5 py-3.5">
                    <div className="flex flex-col gap-2.5">
                        <span className={COLUMN_LABEL_CLASS}>Managed by</span>
                        <Image
                            src="/landing/solana-foundation.svg"
                            alt="Solana Foundation"
                            width={147}
                            height={24}
                            className="h-3.5 w-auto"
                        />
                    </div>
                    <ul className="flex items-center gap-0.5">
                        {SOCIAL_LINKS.map(link => {
                            const Icon = link.icon;
                            return (
                                <li key={link.href}>
                                    <a
                                        href={link.href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        aria-label={link.label}
                                        className="flex size-8 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                                        onClick={() => track(link.destination, link.href)}
                                    >
                                        <Icon className="size-4" aria-hidden="true" />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}
