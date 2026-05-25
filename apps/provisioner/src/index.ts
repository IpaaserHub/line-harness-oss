/**
 * L-harness Provisioner
 *
 * Provisions a dedicated, isolated L-harness instance (one D1 database + one
 * Worker) per TKDir / YTDir account. Called by TKDir / YTDir when a user
 * enables the "LINE連携" feature.
 *
 * Design: docs/plans/2026-05-21-tkdir-ytdir-line-integration-design.md
 *
 * This service is intentionally stateless. The per-account API key is returned
 * once on first provision; the caller (TKDir / YTDir) persists it. Re-calling
 * /provision for an already-provisioned account returns the worker URL only.
 */
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import {
  type AssetFile,
  CloudflareClient,
  CloudflareError,
  type ModuleFile,
  type WorkerBinding,
} from './cloudflare.js';

interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  PROVISIONER_API_KEY: string;
  WORKERS_SUBDOMAIN: string;
  WORKER_BUNDLE_URL: string;
  SCHEMA_SQL_URL: string;
}

const app = new Hono<{ Bindings: Env }>();

/** Constant-time string compare — avoids leaking PROVISIONER_API_KEY. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 192-bit hex API key for the provisioned L-harness instance. */
function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cloudflare Worker / D1 names must be lowercase, alphanumeric + hyphens. */
function instanceName(accountId: string): string {
  const safe = accountId.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
  return `lh-${safe}`;
}

// ─── Auth ────────────────────────────────────────────────────────
app.use('/provision', authGuard);
app.use('/deprovision', authGuard);
app.use('/status/*', authGuard);

async function authGuard(
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !c.env.PROVISIONER_API_KEY || !timingSafeEqual(token, c.env.PROVISIONER_API_KEY)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  return next();
}

// ─── Routes ──────────────────────────────────────────────────────

app.get('/health', (c) => c.json({ status: 'ok', service: 'lh-provisioner' }));

/**
 * POST /provision  { accountId, label? }
 * Idempotent. First call: creates D1 + Worker, returns { workerUrl, apiKey }.
 * Subsequent calls: returns { workerUrl, alreadyProvisioned: true }.
 */
app.post('/provision', async (c) => {
  const body = await c.req.json<{ accountId?: string; label?: string }>().catch(() => ({}));
  if (!body.accountId) {
    return c.json({ success: false, error: 'accountId is required' }, 400);
  }

  const cf = new CloudflareClient(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
  const name = instanceName(body.accountId);
  const workerUrl = `https://${name}.${c.env.WORKERS_SUBDOMAIN}.workers.dev`;

  try {
    // Idempotency: a provisioned account already has its Worker.
    if (await cf.workerExists(name)) {
      return c.json({ success: true, data: { workerUrl, alreadyProvisioned: true } });
    }

    // 1. D1 database (reuse if a prior partial provision left one behind).
    const existingDb = await cf.findD1Database(name);
    const db = existingDb ?? (await cf.createD1Database(name));

    // 2. Apply the L-harness schema.
    const schemaSql = await fetchText(c.env.SCHEMA_SQL_URL, 'schema.sql');
    await cf.queryD1(db.uuid, schemaSql);

    // 3. Fetch the L-harness Worker bundle (multi-module ESM) and optional
    //    client assets (LIFF / admin UI static files served via ASSETS binding).
    const { mainModule, files, clientAssetPaths } = await fetchWorkerBundle(c.env.WORKER_BUNDLE_URL);

    // 4. If the bundle ships client assets, upload them first to get a JWT
    //    that the worker deploy then references via metadata.assets.
    let assetsCompletionJwt: string | undefined;
    if (clientAssetPaths.length > 0) {
      const baseUrl = c.env.WORKER_BUNDLE_URL.replace(/\/[^/]+$/, '');
      const assets = await fetchClientAssets(`${baseUrl}/client`, clientAssetPaths);
      assetsCompletionJwt = await cf.uploadAssets(name, assets);
    }

    // 5. Deploy the L-harness Worker bound to this D1 + ASSETS + R2 IMAGES.
    //    `line-harness-images` is a single shared R2 bucket; per-tenant
    //    isolation comes from the in-Worker code namespacing image keys.
    const apiKey = generateApiKey();
    const bindings: WorkerBinding[] = [
      { type: 'd1', name: 'DB', id: db.uuid },
      { type: 'r2_bucket', name: 'IMAGES', bucket_name: 'line-harness-images' },
    ];
    await cf.deployWorker(name, files, mainModule, bindings, {
      assetsCompletionJwt,
    });

    // 6. Set the instance API key as a Worker secret.
    await cf.putWorkerSecret(name, 'API_KEY', apiKey);

    // 7. Cron triggers are intentionally SKIPPED to avoid the Cloudflare
    //    account-wide limit (Workers Free plan = 5 cron triggers total).
    //    With multiple spawned instances each setting 2 crons, the limit hits
    //    immediately. Re-enable by uncommenting the call below after the
    //    account is upgraded to Workers Paid (unlocks per-worker cron limits).
    // await cf.putCronTriggers(name, ['*/5 * * * *', '0 */6 * * *']);

    // 8. Expose it on workers.dev.
    await cf.enableWorkersDev(name);

    return c.json({ success: true, data: { workerUrl, apiKey, alreadyProvisioned: false } }, 201);
  } catch (err) {
    console.error('provision failed:', err);
    const status = err instanceof CloudflareError ? 502 : 500;
    return c.json({ success: false, error: describe(err) }, status);
  }
});

/** POST /deprovision { accountId } — tears down the instance (e.g. on cancellation). */
app.post('/deprovision', async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => ({}));
  if (!body.accountId) {
    return c.json({ success: false, error: 'accountId is required' }, 400);
  }
  const cf = new CloudflareClient(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
  const name = instanceName(body.accountId);
  try {
    if (await cf.workerExists(name)) await cf.deleteWorker(name);
    const db = await cf.findD1Database(name);
    if (db) await cf.deleteD1Database(db.uuid);
    return c.json({ success: true, data: { deprovisioned: true } });
  } catch (err) {
    console.error('deprovision failed:', err);
    return c.json({ success: false, error: describe(err) }, 502);
  }
});

/** GET /status/:accountId — whether an instance exists. */
app.get('/status/:accountId', async (c) => {
  const cf = new CloudflareClient(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
  const name = instanceName(c.req.param('accountId'));
  try {
    const exists = await cf.workerExists(name);
    return c.json({
      success: true,
      data: {
        status: exists ? 'active' : 'none',
        workerUrl: exists ? `https://${name}.${c.env.WORKERS_SUBDOMAIN}.workers.dev` : null,
      },
    });
  } catch (err) {
    return c.json({ success: false, error: describe(err) }, 502);
  }
});

async function fetchText(url: string, label: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${label} from ${url}: ${res.status}`);
  return res.text();
}

/**
 * Fetch a Vite-built Worker bundle from a manifest URL.
 *
 * Manifest format (JSON):
 *   {
 *     "main_module": "index.js",
 *     "files": ["index.js", "assets/worker-entry-XXX.js", ...],
 *     "client_assets": ["/index.html", "/assets/main-XXX.css", ...]  // optional
 *   }
 *
 * Module `files` are resolved relative to the manifest URL's directory.
 * `client_assets` (URL paths with leading slash) are NOT fetched here — they
 * point into a `client/` sibling directory and are fetched separately via
 * `fetchClientAssets` when ASSETS upload is needed.
 */
async function fetchWorkerBundle(
  manifestUrl: string,
): Promise<{ mainModule: string; files: ModuleFile[]; clientAssetPaths: string[] }> {
  const manifestRes = await fetch(manifestUrl);
  if (!manifestRes.ok) {
    throw new Error(`failed to fetch manifest from ${manifestUrl}: ${manifestRes.status}`);
  }
  const manifest = (await manifestRes.json()) as {
    main_module?: string;
    files?: string[];
    client_assets?: string[];
  };
  if (!manifest.main_module || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`invalid manifest from ${manifestUrl}: missing main_module or files`);
  }
  const baseUrl = manifestUrl.replace(/\/[^/]+$/, '');
  const files = await Promise.all(
    manifest.files.map(async (path) => {
      const fileUrl = `${baseUrl}/${path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) {
        throw new Error(`failed to fetch worker bundle file ${path} from ${fileUrl}: ${res.status}`);
      }
      return { path, content: await res.text() };
    }),
  );
  return {
    mainModule: manifest.main_module,
    files,
    clientAssetPaths: Array.isArray(manifest.client_assets) ? manifest.client_assets : [],
  };
}

/**
 * Fetch the static-asset files (HTML/CSS/JS/etc.) from the hosting and return
 * them as `AssetFile[]` ready for `cf.uploadAssets()`.
 *
 * `baseUrl` is the host directory (e.g. `https://lh-bundles.pages.dev/client`).
 * `paths` are URL paths (with leading slash) as they appear in the manifest's
 * `client_assets`; the same paths are passed straight to Cloudflare as ASSETS
 * routes.
 */
async function fetchClientAssets(baseUrl: string, paths: string[]): Promise<AssetFile[]> {
  return Promise.all(
    paths.map(async (path) => {
      const fileUrl = `${baseUrl}${path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) {
        throw new Error(`failed to fetch client asset ${path} from ${fileUrl}: ${res.status}`);
      }
      return { path, content: await res.arrayBuffer() };
    }),
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'Internal error';
}

export default app;
