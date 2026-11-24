"use client";
import { createContext, useContext, type ReactNode } from "react";
import { setCloudIdentity } from "@/lib/cloud/client";

export type CloudClientUser = { id: string; username: string; role: "admin" | "user"; mustChange: boolean };
type Context = { cloud: boolean; user: CloudClientUser | null; testEnvironment: boolean };
const CloudContext = createContext<Context>({ cloud: false, user: null, testEnvironment: false });
export function CloudProvider({ cloud, user, testEnvironment = false, children }: Omit<Context, "testEnvironment"> & { testEnvironment?: boolean; children: ReactNode }) {
  // Browser tab only. During server rendering no shared mutable identity is touched.
  if (typeof window !== "undefined") setCloudIdentity(user?.id || "", cloud);
  return <CloudContext.Provider value={{ cloud, user, testEnvironment }}>{children}</CloudContext.Provider>;
}
export function useCloud() { return useContext(CloudContext); }
