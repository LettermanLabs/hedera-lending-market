import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
  webpack(config) {
    // MetaMask's browser bundle also contains a React Native-only storage branch.
    // Web wallets use localStorage; this app never targets React Native.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage$": false,
    };
    return config;
  },
};

export default nextConfig;
