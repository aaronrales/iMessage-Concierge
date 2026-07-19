/**
 * Builds a fully-qualified public URL for a path served by this API server.
 *
 * Prefers PUBLIC_API_URL (set by the operator for production deployments) and
 * falls back to the Replit dev-domain convention for local development.
 * Returns null when neither env var is set (e.g. in CI or local-without-domain).
 */
export function buildPublicUrl(path: string): string | null {
  // PUBLIC_API_URL is the operator-configured base for production deployments.
  // In development the API server is proxied at /api on the Replit dev domain.
  const base =
    process.env["PUBLIC_API_URL"] ??
    (process.env["REPLIT_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_DEV_DOMAIN"]}/api`
      : null);
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

/** Returns the canonical URL of the privacy policy page, or null when unavailable. */
export function privacyPolicyUrl(): string | null {
  return buildPublicUrl("privacy");
}
