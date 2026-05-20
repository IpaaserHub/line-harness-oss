import type { Context } from 'hono';
import { getLineAccounts } from '@line-crm/db';
import type { Env } from '../index.js';

interface VerifyResult {
  ok: true;
  sub: string;
  email: string | null;
  name: string | null;
  channelId: string;
}

interface VerifyFailure {
  ok: false;
  reason: 'invalid_token' | 'no_channel_configured';
}

/**
 * Verifies a LINE Login ID token against every configured Login channel
 * (env + DB-registered accounts) and returns the verified `sub` (= LINE userId).
 *
 * For a per-tenant L-harness deployment, "multiple channels" means the single
 * tenant has registered more than one LINE Login channel — not multiple
 * tenants. There is no cross-tenant trust boundary at this layer because each
 * tenant runs an isolated Worker/D1 (WL社 deployment model, 2026-05).
 */
export async function verifyLineIdToken(
  c: Context<Env>,
  idToken: string,
): Promise<VerifyResult | VerifyFailure> {
  const channelIds: string[] = [];
  if (c.env.LINE_LOGIN_CHANNEL_ID) channelIds.push(c.env.LINE_LOGIN_CHANNEL_ID);

  try {
    const dbAccounts = await getLineAccounts(c.env.DB);
    for (const acct of dbAccounts) {
      if (acct.login_channel_id && !channelIds.includes(acct.login_channel_id)) {
        channelIds.push(acct.login_channel_id);
      }
    }
  } catch {
    // DB read failure is non-fatal — fall back to env channel only
  }

  if (channelIds.length === 0) {
    return { ok: false, reason: 'no_channel_configured' };
  }

  for (const channelId of channelIds) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        sub: string;
        email?: string;
        name?: string;
      };
      return {
        ok: true,
        sub: data.sub,
        email: data.email ?? null,
        name: data.name ?? null,
        channelId,
      };
    }
  }

  return { ok: false, reason: 'invalid_token' };
}
