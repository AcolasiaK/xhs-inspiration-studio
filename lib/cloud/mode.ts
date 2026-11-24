// Server mode is never inferred from a browser header or URL.
export function isCloudMode() { return process.env.APP_MODE === "cloud"; }
