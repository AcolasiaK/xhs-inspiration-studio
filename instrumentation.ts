export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.APP_MODE === 'cloud') {
    const { startCloudWorker } = await import('./lib/cloud/server/jobs');
    startCloudWorker();
    return;
  }
  if (process.env.NEXT_RUNTIME === 'nodejs' && (process.env.XHS_HOTSPOTS_SCHEDULER === '1' || process.env.GENERATION_TIMEOUT_PROFILE === 'local') && !process.env.VERCEL) {
    const { startXhsHotspotsScheduler } = await import('./lib/server/xhs-hotspots-store');
    startXhsHotspotsScheduler();
  }
}
