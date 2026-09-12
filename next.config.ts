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
