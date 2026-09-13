import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,

  /**
   * Emits .next/standalone: a self-contained server with only the modules it
   * actually traced. Keeps the runtime image small and means the production
   * container carries no build toolchain.
   */
  output: 'standalone',

  /**
   * `maxmind` reads the GeoLite2 file with node:fs. Next bundles
   * instrumentation.ts for the edge runtime as well as node, and edge has no
   * fs — so bundling it there fails the whole compile even though the code is
   * guarded to nodejs at runtime.
   *
   * Listing it here keeps it out of the bundle and loads it from node_modules
   * at runtime, where fs exists.
   */
  serverExternalPackages: ['maxmind'],

  /**
   * The redirect path is latency-critical (TRD §15, p95 < 300 ms). Source maps
   * in production cost build time and image size for no runtime benefit here.
   */
  productionBrowserSourceMaps: false,

  eslint: {
    // No ESLint config in this project; linting must not block a deploy build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
