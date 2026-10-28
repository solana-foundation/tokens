import type { NextConfig } from 'next';

import { IMAGE_CONTENT_DISPOSITION_TYPE, IMAGE_CONTENT_SECURITY_POLICY } from './src/lib/image-response-headers';

const nextConfig: NextConfig = {
    // Instant Navigations (Next 16.3): explicit caching via 'use cache' and
    // per-route static shells that prefetch/render instantly on client navs.
    cacheComponents: true,
    partialPrefetching: true,
    transpilePackages: ['@tokens/ui', '@tokens/solana', '@tokens/asset-registry'],
    images: {
        // Many token logos (arweave, IPFS gateways) serve SVG content from
        // extension-less URLs; the optimizer rejects them unless SVG is allowed.
        // The CSP sandbox + attachment disposition keep served SVGs inert; the
        // /api/image-proxy route applies the same policy from the shared module.
        dangerouslyAllowSVG: true,
        contentDispositionType: IMAGE_CONTENT_DISPOSITION_TYPE,
        contentSecurityPolicy: IMAGE_CONTENT_SECURITY_POLICY,
        remotePatterns: [
            {
                protocol: 'https',
                hostname: '**',
            },
            // Dev only: the assets API absolutizes local logo paths against the
            // request origin (e.g. http://localhost:3002/logos/popular/solana.png),
            // so next/image needs localhost allowlisted over plain http.
            ...(process.env.NODE_ENV === 'development'
                ? ([
                      { protocol: 'http', hostname: 'localhost' },
                      { protocol: 'http', hostname: '127.0.0.1' },
                  ] as const)
                : []),
        ],
    },
    experimental: {
        // Route handlers bail out of prerendering by throwing; our proxy's
        // try/catch logs those aborts during build without this.
        hideLogsAfterAbort: true,
        externalDir: true,
        optimizePackageImports: ['@tokens/ui', 'lucide-react', 'symbols-react'],
    },
    // PostHog reverse proxy configuration
    async rewrites() {
        const homeCategoryRoutes = ['majors', 'currencies', 'rwas', 'etfs', 'metals', 'stocks'] as const;
        const homeCategoryRewrites = homeCategoryRoutes.flatMap(route => [
            { source: `/${route}`, destination: `/?category=${route}` },
            { source: `/${route}/`, destination: `/?category=${route}` },
        ]);

        return {
            beforeFiles: [
                // Legacy: `/stables` → currencies
                { source: '/stables', destination: '/?category=currencies' },
                { source: '/stables/', destination: '/?category=currencies' },
                ...homeCategoryRewrites,
            ],
            afterFiles: [
                // Dev only: curated /logos/* assets live in apps/api's public dir.
                // `normalizeLogoSrc` rewrites loopback logo URLs to relative paths;
                // anything not found in our own public dir proxies to the API.
                // (afterFiles = local public/ files win first.)
                ...(process.env.NODE_ENV !== 'production'
                    ? [
                          {
                              source: '/logos/:path*',
                              destination: `${(process.env.API_BASE_URL ?? process.env.TOKENS_API_ORIGIN ?? 'http://localhost:3002').trim().replace(/\/$/, '')}/logos/:path*`,
                          },
                      ]
                    : []),
                {
                    source: '/ingest/static/:path*',
                    destination: 'https://us-assets.i.posthog.com/static/:path*',
                },
                {
                    source: '/ingest/:path*',
                    destination: 'https://us.i.posthog.com/:path*',
                },
            ],
        };
    },
    // Required to support PostHog trailing slash API requests
    skipTrailingSlashRedirect: true,
};

export default nextConfig;
