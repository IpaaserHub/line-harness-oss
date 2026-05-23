/**
 * Resolves the L-harness Worker API base URL.
 *
 * Standalone: the build-time `NEXT_PUBLIC_API_URL`.
 * Embedded as an iframe inside TKDir / YTDir: the parent frame injects the
 * per-account Worker URL via postMessage (see `auth-guard.tsx`), stored under
 * `lh_api_url`. This lets a single admin build serve every account's isolated
 * Worker without rebuilding per account.
 */
export function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    const bridged = window.localStorage.getItem('lh_api_url');
    if (bridged) return bridged;
  }
  return process.env.NEXT_PUBLIC_API_URL ?? '';
}
