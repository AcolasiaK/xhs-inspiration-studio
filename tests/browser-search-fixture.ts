import { mock } from "node:test";
import { browserSearchTransport } from "../lib/server/browser-search";

/** Emulates only the external CLI boundary; the provider parser stays real. */
export function mockSearchBrowser(onSearch: (query: string) => Promise<unknown[]> | unknown[]) {
  let url = "";
  return mock.method(browserSearchTransport, "run", async (args: string[]) => {
    if (args[0] === "open") { url = args[1]; return { targetId: "test-search-tab" }; }
    if (args[0] === "navigate") { url = args[1]; return { ok: true }; }
    if (args[0] === "evaluate") {
      const page = new URL(url);
      if (page.hostname === "cn.bing.com" && page.pathname === "/search") {
        return { result: { url, blocked: false, pages: await onSearch(page.searchParams.get("q") ?? "") } };
      }
      return { result: { url, text: "" } };
    }
    return { ok: true };
  });
}
