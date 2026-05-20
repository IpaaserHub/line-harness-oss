import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { timingSafeEqual } from '../utils/timing-safe.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 min — matches Stripe's official SDK default

type StripeVerifyResult =
  | { valid: true }
  | { valid: false; reason: 'missing_parts' | 'stale_timestamp' | 'no_matching_signature' };

/**
 * Verifies a Stripe webhook signature header.
 *
 * Mirrors `stripe.webhooks.constructEvent` from the official SDK (which we
 * don't bundle, to keep the Worker small):
 *   header format: `t=<timestamp>,v1=<sig>,v1=<sig>,...` (multiple v1 during key rotation)
 *   signed payload: `<timestamp>.<rawBody>`
 *   compare:        HMAC-SHA256(secret, signed payload) hex, constant-time, against every v1
 *   freshness:      |now - t| <= tolerance
 */
async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  sigHeader: string,
  toleranceSeconds = STRIPE_TIMESTAMP_TOLERANCE_SECONDS,
): Promise<StripeVerifyResult> {
  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 't') timestamp = v;
    else if (k === 'v1') v1Signatures.push(v);
  }
  if (!timestamp || v1Signatures.length === 0) {
    return { valid: false, reason: 'missing_parts' };
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return { valid: false, reason: 'missing_parts' };
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  for (const candidate of v1Signatures) {
    if (timingSafeEqual(computedSig, candidate)) {
      return { valid: true };
    }
  }
  return { valid: false, reason: 'no_matching_signature' };
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;

    // Fail closed: refuse unsigned webhooks. Previously the handler accepted
    // any JSON body when STRIPE_WEBHOOK_SECRET was unset (a dev convenience),
    // which turns a forgotten env var into a path to forged
    // `payment_intent.succeeded` events that trigger scoring, tagging and the
    // cv_fire automation bus.
    if (!stripeSecret) {
      console.error('Stripe webhook hit but STRIPE_WEBHOOK_SECRET is not configured');
      return c.json(
        { success: false, error: 'Stripe webhook is not configured on this deployment' },
        503,
      );
    }

    const sigHeader = c.req.header('Stripe-Signature') ?? '';
    const rawBody = await c.req.text();

    const result = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
    if (!result.valid) {
      console.warn('Stripe signature verification failed:', result.reason);
      return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
    }
    const body = JSON.parse(rawBody) as StripeWebhookBody;

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase');

      // 自動タグ付け（product_idベース）
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(`SELECT id FROM tags WHERE name = ?`)
          .bind(`purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await db
            .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
            .bind(friendId, tag.id, jstNow())
            .run();
        }
      }

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../services/event-bus.js');
      await fireEvent(db, 'cv_fire', { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } });
    }

    // サブスクリプションイベント処理
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(`SELECT id FROM tags WHERE name = 'subscription_cancelled'`)
        .first<{ id: string }>();
      if (cancelledTag) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friendId, cancelledTag.id, jstNow())
          .run();
      }
    }

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { stripe };
