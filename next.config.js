/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // All images are served from /public; no remote hosts are allowed.
    deviceSizes: [360, 414, 640, 768, 1024, 1280, 1536, 1600],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
};

export default nextConfig;
