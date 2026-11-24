import "server-only";
import { AppError } from "@/lib/errors";
import { getPageAuthState, type AuthState } from "./auth";

/** A display-only fallback; protected pages and every API still enforce auth. */
export async function pageAuthForDisplay(load: () => Promise<AuthState> = getPageAuthState) {
  try { return {state: await load(), configurationError: false}; }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== "CLOUD_CONFIG") throw error;
    return {state: {gateVerified: false, user: null, bootstrapComplete: false} satisfies AuthState, configurationError: true};
  }
}
