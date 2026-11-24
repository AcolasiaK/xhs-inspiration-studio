declare module "jsonwebtoken" {
  export function verify(token: string, key: string | import("node:crypto").KeyObject, options: { algorithms: string[]; issuer: string; audience: string; clockTolerance: number }): string | { [key: string]: unknown };
}
