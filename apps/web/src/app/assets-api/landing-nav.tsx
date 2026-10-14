import { SiteMenu } from '@/components/site-menu';
import { TrackedAnchor, TrackedLink } from '@/components/tracked-link';

function LandingLogo() {
    return (
        <svg width={20} height={20} viewBox="0 0 212 212" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <path
                d="M106 127.2C129.42 127.2 148.4 146.18 148.4 169.6C148.4 193.02 129.42 212 106 212C82.58 212 63.6 193.02 63.6 169.6C63.6 146.18 82.58 127.2 106 127.2ZM42.4 63.6C65.82 63.6 84.8 82.58 84.8 106C84.8 129.42 65.82 148.4 42.4 148.4C18.98 148.4 0 129.42 0 106C0 82.58 18.98 63.6 42.4 63.6ZM169.6 63.6C193.02 63.6 212 82.58 212 106C212 129.42 193.02 148.4 169.6 148.4C146.18 148.4 127.2 129.42 127.2 106C127.2 82.58 146.18 63.6 169.6 63.6ZM106 0C129.42 0 148.4 18.98 148.4 42.4C148.4 65.82 129.42 84.8 106 84.8C82.58 84.8 63.6 65.82 63.6 42.4C63.6 18.98 82.58 0 106 0Z"
                fill="white"
            />
        </svg>
    );
}

export function LandingNav() {
    return (
        <header className="fixed inset-x-0 top-0 z-40">
            <div className="mx-auto flex items-center justify-between gap-4 px-6 py-4">
                <SiteMenu tone="dark" label="Assets API" logo={<LandingLogo />} />

                <nav className="flex items-center gap-6 sm:gap-8">
                    <div className="hidden items-center gap-2 sm:flex sm:gap-2">
                        <TrackedAnchor
                            href="https://docs.tokens.xyz"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-10 items-center px-2 font-inter-semibold text-[length:var(--text-button-lg)] leading-none text-text-low transition-colors duration-150 hover:text-text-extra-high"
                            trackingEvent="api_cta_clicked"
                            trackingProperties={{
                                cta: 'documentation',
                                link_url: 'https://docs.tokens.xyz',
                                source: 'assets_api_landing_nav',
                            }}
                        >
                            Docs
                        </TrackedAnchor>
                    </div>

                    <TrackedLink
                        href="https://app.tokens.xyz"
                        className="inline-flex h-9 items-center justify-center rounded-full bg-white px-3.5 text-[length:var(--text-button-md)] leading-none font-inter-semibold text-black transition-[colors,transform] duration-150 hover:bg-white/90 active:scale-[0.96]"
                        trackingEvent="api_cta_clicked"
                        trackingProperties={{
                            cta: 'get_api_keys',
                            link_url: 'https://app.tokens.xyz',
                            source: 'assets_api_landing_nav',
                        }}
                    >
                        Get your API keys
                    </TrackedLink>
                </nav>
            </div>
        </header>
    );
}
