/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // All images are served from /public; no remote hosts are allowed.
    deviceSizes: [360, 414, 640, 768, 1024, 1280, 1536, 1600],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  // Keep old links working for pages that were removed.
  async redirects() {
    return [
      { source: "/payment/success", destination: "/dashboard", permanent: false },
      { source: "/payment/cancel", destination: "/dashboard/billing", permanent: false },
      { source: "/preview", destination: "/guide", permanent: true },
      { source: "/full-access", destination: "/guide", permanent: true },
      { source: "/demo", destination: "/example", permanent: true },
      { source: "/brand-details", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
