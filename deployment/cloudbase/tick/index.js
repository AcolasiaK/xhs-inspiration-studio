// SCF event function: set these two environment variables in the cloud console.
// This function never prints credentials, URLs, response bodies or user content.
exports.main_handler = async function () {
  const address = process.env.CLOUD_CRON_URL || "";
  const secret = process.env.CLOUD_CRON_SECRET || "";
  let url;
  try { url = new URL(address); } catch { throw new Error("定时调用地址未配置。"); }
  if (url.protocol !== "https:" || secret.length < 32 || url.username || url.password || url.search || url.hash || url.pathname !== "/api/cloud/cron") throw new Error("定时配置无效。");
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(55_000) });
  if (!response.ok) throw new Error("热点定时更新未成功，请检查服务状态。");
  return { ok: true };
};
