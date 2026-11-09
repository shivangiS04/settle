/** @type {import('next').NextConfig} */
const nextConfig = {
  // Serve the static known-good verifier delivery at /demo-delivery (and /demo-delivery/).
  async rewrites() {
    return [{ source: "/demo-delivery", destination: "/demo-delivery/index.html" }];
  },
  experimental: {
    instrumentationHook: true,
    // Native/heavy server deps must not be bundled by webpack.
    serverComponentsExternalPackages: ["playwright", "playwright-core", "@paypal/agent-toolkit", "@prisma/client"],
  },
};

export default nextConfig;
