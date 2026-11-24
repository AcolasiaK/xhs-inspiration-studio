import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // Only the local installer requests a self-contained production release.
  ...(process.env.XHS_LOCAL_STANDALONE === "1" ? {
    output: "standalone" as const,
    outputFileTracingIncludes: { "/api/personal/polish": ["./vendor/humanizer-zh/SKILL.md", "./vendor/humanizer-zh/source.json"] },
  } : {}),
  experimental: {
    // This local workspace cannot reliably retain Turbopack's on-disk task cache.
    // Keep development compilation in memory instead of restoring missing SST files.
    turbopackFileSystemCacheForDev: false,
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};
export default config;
