import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // keep the dev badge off the left rail's panel headings
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
