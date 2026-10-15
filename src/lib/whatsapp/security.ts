import { createHash, timingSafeEqual } from "node:crypto";

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export const hashChallenge = (tokenHash: string, code: string) => hashToken(tokenHash + ":" + code);
export const isExpired = (expiresAt: string) => Date.parse(expiresAt) < Date.now();

export function matchesSecret(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || expected.length < 32) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function siteUrl(path = ""): string {
  const base = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002");
  if (!path.startsWith("/") && path !== "") throw new Error("Destino inválido.");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("Configure uma URL HTTPS para a loja.");
  return base.origin + path;
}
