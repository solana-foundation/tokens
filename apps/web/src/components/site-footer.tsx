'use client';

import Image from 'next/image';
import Link from 'next/link';
import { FooterAsteroidsEasterEgg } from '@/app/assets-api/footer-asteroids-easter-egg';
import { trackEvent } from '@/lib/posthog-client';
import { Logo } from './logo';

type FooterTone = 'dark' | 'light';

interface SiteFooterProps {
    tone?: FooterTone;
    asteroidsOpen?: boolean;
    onAsteroidsOpenChange?: (open: boolean) => void;
}

export function SiteFooter({ tone = 'dark', asteroidsOpen, onAsteroidsOpenChange }: SiteFooterProps) {
    const labelClass =
        tone === 'dark'
            ? 'font-inter text-[length:var(--text-body-md-size)] leading-[var(--leading-normal)] text-text-extra-low'
            : 'font-inter text-[length:var(--text-body-md-size)] leading-[var(--leading-normal)] text-text-low';
    const linkClass =
        "relative font-inter text-[length:var(--text-body-md-size)] leading-[var(--leading-normal)] text-text-high hover:text-text-extra-high transition-colors before:absolute before:inset-x-0 before:-top-1.5 before:-bottom-1.5 before:content-['']";
    const canLaunchAsteroids = asteroidsOpen !== undefined && onAsteroidsOpenChange !== undefined;

    return (
        <>
            <style>{`
                @keyframes footer-logo-hover-spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .footer-logo-hover-spin svg {
                    transform-origin: 50% 50%;
                    transform-box: fill-box;
                }
                .footer-logo-hover-spin:hover svg {
                    animation: footer-logo-hover-spin 700ms cubic-bezier(0.22, 1, 0.36, 1);
                }
                @media (prefers-reduced-motion: reduce) {
                    .footer-logo-hover-spin:hover svg { animation: none; }
                }
            `}</style>
            <footer className="flex w-full flex-col items-start gap-10 py-11 md:flex-row md:items-start md:justify-between md:gap-0">
                <div className="flex w-full flex-col items-start gap-10 md:w-auto md:flex-row md:gap-12 lg:gap-24">
                    <div className="flex flex-col items-start gap-6">
                        <p className={labelClass}>Managed by</p>
                        <SolanaFoundationMark tone={tone} />
                    </div>
                    <div className="flex flex-col items-start gap-6">
                        <p className={labelClass}>Socials</p>
                        <div className="flex flex-col items-start gap-3">
                            <Link
                                href="https://x.com/tokens"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('external_link_clicked', {
                                        link_type: 'x',
                                        link_url: 'https://x.com/tokens',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                X
                            </Link>
                            <Link
                                href="https://solana.com"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('external_link_clicked', {
                                        link_type: 'website',
                                        link_url: 'https://solana.com',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Solana Website
                            </Link>
                        </div>
                    </div>
                    <div className="flex flex-col items-start gap-6">
                        <p className={labelClass}>Tokens</p>
                        <div className="flex flex-col items-start gap-3">
                            <Link
                                href="/partners"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('nav_link_clicked', {
                                        destination: 'partners',
                                        link_url: '/partners',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Partners
                            </Link>
                            <Link
                                href="/status"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('nav_link_clicked', {
                                        destination: 'status',
                                        link_url: '/status',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Status
                            </Link>
                            <Link
                                href="/dex"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('nav_link_clicked', {
                                        destination: 'dex',
                                        link_url: '/dex',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Dex
                            </Link>
                            <Link
                                href="https://github.com/solana-foundation"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('external_link_clicked', {
                                        link_type: 'github',
                                        link_url: 'https://github.com/solana-foundation',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Github
                            </Link>
                            <Link
                                href="https://t.me/solana"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('external_link_clicked', {
                                        link_type: 'telegram',
                                        link_url: 'https://t.me/solana',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Telegram
                            </Link>
                        </div>
                    </div>
                    <div className="flex flex-col items-start gap-6">
                        <p className={labelClass}>Legal</p>
                        <div className="flex flex-col items-start gap-3">
                            <Link
                                href="/terms"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('nav_link_clicked', {
                                        destination: 'terms',
                                        link_url: '/terms',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Terms
                            </Link>
                            <Link
                                href="/privacy-policy"
                                className={linkClass}
                                onClick={() =>
                                    trackEvent('nav_link_clicked', {
                                        destination: 'privacy_policy',
                                        link_url: '/privacy-policy',
                                        source: 'site_footer',
                                    })
                                }
                            >
                                Privacy Policy
                            </Link>
                        </div>
                    </div>
                </div>
                {canLaunchAsteroids ? (
                    <FooterAsteroidsEasterEgg open={asteroidsOpen} onOpenChange={onAsteroidsOpenChange} tone={tone} />
                ) : (
                    <Link
                        href="/"
                        aria-label="Tokens home"
                        className="footer-logo-hover-spin inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-95 md:self-start"
                        onClick={() =>
                            trackEvent('nav_link_clicked', {
                                destination: 'home',
                                link_url: '/',
                                source: 'site_footer',
                            })
                        }
                    >
                        <Logo width={24} height={24} />
                    </Link>
                )}
            </footer>
        </>
    );
}

function SolanaFoundationMark({ tone }: { tone: FooterTone }) {
    return (
        <Image
            src="/landing/solana-foundation.svg"
            alt="Solana Foundation"
            width={147}
            height={24}
            className={`h-6 w-auto ${tone === 'light' ? 'brightness-0' : ''}`}
            priority={false}
        />
    );
}
