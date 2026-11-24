// Identity is held only in this browser tab; credentials remain in HttpOnly cookies.
let workspaceId = "";
let cloudMode = false;
export function setCloudIdentity(id: string, cloud = true) { workspaceId = id; cloudMode = cloud; }
export function isCloudClient() { return cloudMode; }
export function cloudFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (cloudMode && workspaceId) headers.set("X-Workspace-User", workspaceId);
  return fetch(input, { ...init, headers, cache: "no-store", credentials: "same-origin" });
}

export function aiStorageNamespace(){return cloudMode ? workspaceId || "signed-out" : "local-owner";}
