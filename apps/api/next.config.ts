import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    experimental: {
        externalDir: true,
    },
    async rewrites() {
        return [
            // Public API contract is `/v1/...` / `/v2/...` (see docs). Internally
            // this app namespaces route handlers under `/api/v1/...` etc.
            { source: '/v1/:path*', destination: '/api/v1/:path*' },
            { source: '/v2/:path*', destination: '/api/v2/:path*' },
        ];
    },
};

export default nextConfig;
