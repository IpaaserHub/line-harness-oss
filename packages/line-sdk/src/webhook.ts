/**
 * Verifies the X-Line-Signature header using HMAC-SHA256.
 * Must be called before processing any webhook event.
 *
 * @param channelSecret - LINE channel secret
 * @param body          - Raw request body string (before JSON.parse)
 * @param signature     - Value of the X-Line-Signature header (base64)
 * @returns true if the signature is valid, false otherwise
 */
export async function verifySignature(
  channelSecret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(body),
  );

  // Convert computed HMAC to base64 (safe for all buffer sizes)
  const bytes = new Uint8Array(signatureBytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const computedBase64 = btoa(binary);

  // Constant-time comparison: avoid leaking the secret one byte at a time
  // via JS `===` short-circuit. Length mismatch is treated as non-secret.
  if (computedBase64.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computedBase64.length; i++) {
    diff |= computedBase64.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
