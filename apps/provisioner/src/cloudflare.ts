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
   * NOTE: the L-harness Worker can also serve static assets (the LIFF client)
   * via an ASSETS binding. Assets require Cloudflare's separate asset-upload
   * session flow (POST .../workers/scripts/{name}/assets-upload-session) and
   * are intentionally out of this Phase C scaffold — see
   * docs/plans/2026-05-21-tkdir-ytdir-line-integration-design.md §8. The
   * spawned Worker functions without ASSETS as long as callers only hit
   * defined API routes (the iframe at apps/web only calls /api/*).
   */
  async deployWorker(
    scriptName: string,
    modules: ModuleFile[],
    mainModule: string,
    bindings: WorkerBinding[],
    compatibilityDate = '2024-12-01',
  ): Promise<void> {
    const metadata = {
      main_module: mainModule,
      compatibility_date: compatibilityDate,
      bindings,
    };
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
  | { type: 'plain_text'; name: string; text: string };

/** A single ES module file in a multi-module Worker upload. */
export type ModuleFile = {
  /** Module path as referenced by imports in the entry module. */
  path: string;
  /** UTF-8 source of the module. */
  content: string;
};
