/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    instrumentationHook: true,
    // Native/heavy server deps must not be bundled by webpack.
    serverComponentsExternalPackages: ["playwright", "playwright-core", "@paypal/agent-toolkit", "@prisma/client"],
  },
};

export default nextConfig;
