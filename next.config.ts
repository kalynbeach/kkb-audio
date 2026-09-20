import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
};
export default config;
