import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder so a stray lockfile in the home dir
  // doesn't get picked up as the root.
  turbopack: { root: __dirname },
};

export default nextConfig;
