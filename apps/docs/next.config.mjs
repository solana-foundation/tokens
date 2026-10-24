import { createMDX } from "fumadocs-mdx/next";

/** Old page URLs, kept alive after the docs reorganisation. */
const movedPages = {
  "/v1/overview": "/v1",
  "/v1/endpoints-at-a-glance": "/v1",
  "/v1/rate-limits-and-errors": "/v1/errors-and-limits",
  "/v1/endpoints/assets": "/v1/endpoints/search-and-resolve",
  "/v1/endpoints/asset-by-id": "/v1/endpoints/asset-detail",
  "/v1/endpoints/meta": "/v1/endpoints/health",
  "/v1/endpoints/news-feed": "/v1/endpoints/news",
  "/v2/overview": "/v2",
  "/v2/rate-limits-and-errors": "/v2/errors-and-limits",
  "/v2/endpoints/registry": "/registry/endpoints",
};

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: ["@tokens/ui"],
  experimental: {
    externalDir: true,
    optimizePackageImports: ["@tokens/ui"],
  },
  async redirects() {
    return [
      { source: "/", destination: "/v1", permanent: false },
      // The site is served at the root; older links carried a /docs prefix.
      { source: "/docs", destination: "/v1", permanent: true },
      { source: "/docs/:path*", destination: "/:path*", permanent: true },
      ...Object.entries(movedPages).map(([source, destination]) => ({
        source,
        destination,
        permanent: true,
      })),
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
