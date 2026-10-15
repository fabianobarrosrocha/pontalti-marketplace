/** Destinos de autenticação ficam na própria loja, inclusive após cadastro. */
export function safeAuthRedirect(value?: string | null, fallback = "/conta"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value) || value.length > 1000)
    return fallback;
  try {
    return new URL(value, "https://pontalti.local").origin === "https://pontalti.local" ? value : fallback;
  } catch {
    return fallback;
  }
}
