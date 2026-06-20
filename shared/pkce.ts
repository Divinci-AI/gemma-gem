/**
 * PKCE (RFC 7636) helpers for the Auth0 Authorization-Code + PKCE flow.
 *
 * The extension is a public client (no client secret), so it proves
 * possession of the authorization code with a one-time code_verifier whose
 * SHA-256 (the code_challenge) is sent up-front on /authorize. Pure Web Crypto
 * — runs in the background service worker (and is unit-testable under Node 18+,
 * which exposes the same `crypto` global).
 */

/** Base64url-encode bytes (RFC 4648 §5: +/→-_ , no padding). */
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Random base64url string from `byteLength` crypto-random bytes. */
function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/**
 * A high-entropy code_verifier (RFC 7636 §4.1: 43–128 chars from the
 * unreserved set). 32 random bytes → 43 base64url chars.
 */
export function generateCodeVerifier(): string {
  return randomBase64Url(32)
}

/** Opaque CSRF `state` value to bind the /authorize request to its callback. */
export function generateState(): string {
  return randomBase64Url(16)
}

/** code_challenge = base64url(SHA-256(code_verifier)) (the S256 method). */
export async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64UrlEncode(new Uint8Array(digest))
}
