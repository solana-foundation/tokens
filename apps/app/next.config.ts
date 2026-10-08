import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    transpilePackages: ['@tokens/cloudrun-shutdown', '@tokens/ui'],
    experimental: {
        externalDir: true,
        optimizePackageImports: ['@tokens/ui'],
    },
};

export default nextConfig;
