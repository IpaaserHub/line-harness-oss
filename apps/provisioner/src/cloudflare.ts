/**
 * Minimal Cloudflare REST API client for provisioning per-account
 * L-harness instances (one isolated D1 database + one isolated Worker each).
 *
 * API reference: https://developers.cloudflare.com/api/
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly cfErrors: Array<{ code: number; message: string }> = [],
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

export class CloudflareClient {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
      ...extraHeaders,
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body; // let fetch set the multipart boundary
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
    const json = (await res.json()) as CfEnvelope<T>;
    if (!res.ok || !json.success) {
      const msg = json.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') || res.statusText;
      throw new CloudflareError(`Cloudflare API ${method} ${path} failed: ${msg}`, res.status, json.errors);
    }
    return json.result;
  }

  // ─── D1 ────────────────────────────────────────────────────────

  /** Creates a D1 database. Returns its uuid. */
  async createD1Database(name: string): Promise<{ uuid: string; name: string }> {
    return this.request('POST', `/accounts/${this.accountId}/d1/database`, { name });
  }

  /** Finds a D1 database by name, or null. Used for idempotency. */
  async findD1Database(name: string): Promise<{ uuid: string; name: string } | null> {
    const list = await this.request<Array<{ uuid: string; name: string }>>(
      'GET',
      `/accounts/${this.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    );
    return list.find((db) => db.name === name) ?? null;
  }

  /** Executes SQL against a D1 database. Used to apply schema.sql. */
  async queryD1(databaseId: string, sql: string): Promise<void> {
    await this.request('POST', `/accounts/${this.accountId}/d1/database/${databaseId}/query`, { sql });
  }

  async deleteD1Database(databaseId: string): Promise<void> {
    await this.request('DELETE', `/accounts/${this.accountId}/d1/database/${databaseId}`);
  }

  // ─── Workers ───────────────────────────────────────────────────

  /** Returns true if a Worker script with this name already exists. */
  async workerExists(scriptName: string): Promise<boolean> {
    try {
      await this.request('GET', `/accounts/${this.accountId}/workers/scripts/${scriptName}`);
      return true;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Uploads / updates a Worker script with its bindings. Supports multi-module
   * bundles (Vite output with code splitting): each entry in `modules` becomes
   * a separate form field, and `mainModule` identifies the entry module.
   *
   * Cloudflare's runtime resolves relative imports between the uploaded files
   * (e.g. `import './assets/worker-entry-XXX.js'`) so module-split bundles
   * work directly without re-bundling into a single file.
   *
   * Pass `assetsCompletionJwt` (from `uploadAssets()`) to attach static assets
   * served via the ASSETS binding. When present, the metadata gets an
   * `assets.jwt` field and an `assets` binding is appended to `bindings`.
   */
  async deployWorker(
    scriptName: string,
    modules: ModuleFile[],
    mainModule: string,
    bindings: WorkerBinding[],
    options: DeployWorkerOptions = {},
  ): Promise<void> {
    const compatibilityDate = options.compatibilityDate ?? '2024-12-01';
    const metadata: Record<string, unknown> = {
      main_module: mainModule,
      compatibility_date: compatibilityDate,
      bindings: options.assetsCompletionJwt
        ? [...bindings, { type: 'assets', name: options.assetsBindingName ?? 'ASSETS' }]
        : bindings,
    };
    if (options.assetsCompletionJwt) {
      metadata.assets = {
        jwt: options.assetsCompletionJwt,
        config: { run_worker_first: options.assetsRunWorkerFirst ?? true },
      };
    }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const mod of modules) {
      form.append(
        mod.path,
        new Blob([mod.content], { type: 'application/javascript+module' }),
        mod.path,
      );
    }
    await this.request('PUT', `/accounts/${this.accountId}/workers/scripts/${scriptName}`, form);
  }

  /**
   * Uploads static assets for the ASSETS binding, returning a completion JWT
   * that must be passed into the subsequent `deployWorker()` call as
   * `options.assetsCompletionJwt`.
   *
   * Implements Cloudflare's three-step assets-upload-session flow:
   *   1. POST `.../assets-upload-session` with a manifest of
   *      `{ "<path>": { hash, size } }` for every file we want served.
   *      Response includes a session JWT and an array of "buckets" — groups of
   *      file hashes that the server doesn't yet have cached.
   *   2. For each non-empty bucket, POST `.../workers/assets/upload?base64=true`
   *      with the session JWT and a multipart body whose field names are the
   *      file hashes, values are the base64-encoded contents. Each call returns
   *      a fresh JWT — the last one is the completion token.
   *   3. Caller passes the final JWT into `deployWorker()`'s `assets.jwt`.
   *
   * Hash format is the first 16 bytes of sha256, lowercase hex (32 chars).
   * Assets API ref: https://developers.cloudflare.com/api/operations/worker-script-upload-assets-1
   */
  async uploadAssets(scriptName: string, assets: AssetFile[]): Promise<string> {
    // Pre-compute manifest (hash + size for each asset)
    const manifestEntries: Array<{ path: string; hash: string; size: number; content: ArrayBuffer }> = [];
    for (const asset of assets) {
      const hash = await sha256TruncatedHex(asset.content);
      manifestEntries.push({ path: asset.path, hash, size: asset.content.byteLength, content: asset.content });
    }
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const e of manifestEntries) {
      manifest[e.path] = { hash: e.hash, size: e.size };
    }

    // Step 1: start upload session
    const sessionRes = await this.request<{ jwt: string; buckets?: string[][] }>(
      'POST',
      `/accounts/${this.accountId}/workers/scripts/${scriptName}/assets-upload-session`,
      { manifest },
    );
    let completionJwt = sessionRes.jwt;
    const buckets = sessionRes.buckets ?? [];

    // Step 2: upload buckets (parallel within bucket, sequential between buckets so
    // each new JWT chains forward). Each upload uses the LATEST JWT (the session
    // JWT for the first bucket, then the JWT returned by each previous upload).
    const hashToEntry = new Map<string, (typeof manifestEntries)[number]>();
    for (const e of manifestEntries) hashToEntry.set(e.hash, e);

    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const form = new FormData();
      for (const hash of bucket) {
        const entry = hashToEntry.get(hash);
        if (!entry) continue; // hash not in our manifest — shouldn't happen
        const base64 = arrayBufferToBase64(entry.content);
        form.append(
          hash,
          new Blob([base64], { type: contentTypeForPath(entry.path) }),
          hash,
        );
      }
      // The assets upload endpoint authenticates with the session JWT (not the
      // account API token), so we bypass `this.request` and call fetch directly.
      const uploadRes = await fetch(
        `${API_BASE}/accounts/${this.accountId}/workers/assets/upload?base64=true`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${completionJwt}` },
          body: form,
        },
      );
      const uploadJson = (await uploadRes.json()) as CfEnvelope<{ jwt?: string }>;
      if (!uploadRes.ok || !uploadJson.success) {
        const msg = uploadJson.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') || uploadRes.statusText;
        throw new CloudflareError(
          `Cloudflare API POST /workers/assets/upload failed: ${msg}`,
          uploadRes.status,
          uploadJson.errors,
        );
      }
      if (uploadJson.result?.jwt) {
        completionJwt = uploadJson.result.jwt;
      }
    }

    return completionJwt;
  }

  /** Sets a secret on a Worker script. */
  async putWorkerSecret(scriptName: string, name: string, text: string): Promise<void> {
    await this.request('PUT', `/accounts/${this.accountId}/workers/scripts/${scriptName}/secrets`, {
      name,
      text,
      type: 'secret_text',
    });
  }

  /** Enables the workers.dev subdomain route for a script. */
  async enableWorkersDev(scriptName: string): Promise<void> {
    await this.request('POST', `/accounts/${this.accountId}/workers/scripts/${scriptName}/subdomain`, {
      enabled: true,
    });
  }

  async deleteWorker(scriptName: string): Promise<void> {
    await this.request('DELETE', `/accounts/${this.accountId}/workers/scripts/${scriptName}`);
  }
}

export type WorkerBinding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'r2_bucket'; name: string; bucket_name: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'assets'; name: string };

/** A single ES module file in a multi-module Worker upload. */
export type ModuleFile = {
  /** Module path as referenced by imports in the entry module. */
  path: string;
  /** UTF-8 source of the module. */
  content: string;
};

/** A single static asset file for ASSETS-binding upload. */
export type AssetFile = {
  /** URL path the asset is served at (with leading slash, e.g. `/index.html`). */
  path: string;
  /** Raw file content. */
  content: ArrayBuffer;
};

export type DeployWorkerOptions = {
  compatibilityDate?: string;
  /** Completion JWT from `uploadAssets()`. When set, an ASSETS binding is appended. */
  assetsCompletionJwt?: string;
  /** Binding name for ASSETS (defaults to `"ASSETS"`). */
  assetsBindingName?: string;
  /**
   * Whether the Worker handles requests before ASSETS does. The L-harness
   * Worker relies on this (e.g. bot UA → OGP HTML injection) — see
   * apps/worker/wrangler.toml `run_worker_first`. Defaults to true.
   */
  assetsRunWorkerFirst?: boolean;
};

/** sha256(content) → first 16 bytes as lowercase hex (32 chars). */
async function sha256TruncatedHex(content: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', content);
  const bytes = new Uint8Array(hashBuffer).subarray(0, 16);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** ArrayBuffer → base64 (latin1-safe). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // Chunk to keep String.fromCharCode argument count manageable for large files.
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Guess Content-Type from file extension for ASSETS upload metadata. */
function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.html')) return 'text/html;charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css;charset=utf-8';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript;charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json;charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  return 'application/octet-stream';
}
