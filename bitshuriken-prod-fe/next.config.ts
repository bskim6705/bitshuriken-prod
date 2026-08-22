import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker runtime image.
  output: "standalone",
};

export default nextConfig;
