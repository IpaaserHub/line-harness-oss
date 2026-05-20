# L-harness Provisioner

TKDir / YTDir のアカウントごとに、独立した L-harness インスタンス（D1 + Worker 各1）を払い出す Cloudflare Worker サービス。

設計: [`docs/plans/2026-05-21-tkdir-ytdir-line-integration-design.md`](../../docs/plans/2026-05-21-tkdir-ytdir-line-integration-design.md)

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| `POST` | `/provision` | アカウント用インスタンスを払い出す（冪等） |
| `POST` | `/deprovision` | インスタンスを削除 |
| `GET` | `/status/:accountId` | プロビジョニング状態の照会 |
| `GET` | `/health` | ヘルスチェック（認証不要） |

`/provision` `/deprovision` `/status` は `Authorization: Bearer <PROVISIONER_API_KEY>` が必要。

### `POST /provision`

```jsonc
// リクエスト
{ "accountId": "<TKDir/YTDir のアカウント or 組織 ID>", "label": "任意の表示名" }

// 初回レスポンス
{ "success": true, "data": { "workerUrl": "https://lh-xxx.<sub>.workers.dev", "apiKey": "...", "alreadyProvisioned": false } }

// 2回目以降（冪等）
{ "success": true, "data": { "workerUrl": "https://lh-xxx.<sub>.workers.dev", "alreadyProvisioned": true } }
```

`apiKey` は**初回のみ**返る。呼び出し側（TKDir / YTDir）が保存する責任を持つ。

## 設定

### vars（`wrangler.toml`）
- `CLOUDFLARE_ACCOUNT_ID` — WL社 Cloudflare アカウント ID
- `WORKERS_SUBDOMAIN` — workers.dev サブドメイン
- `WORKER_BUNDLE_URL` — 事前ビルド済み L-harness worker バンドルの URL
- `SCHEMA_SQL_URL` — `packages/db/schema.sql` の URL

### secrets（`wrangler secret put`）
- `CLOUDFLARE_API_TOKEN` — D1 作成 + Worker デプロイ権限を持つ API トークン
- `PROVISIONER_API_KEY` — 呼び出し元認証用の共有鍵

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put PROVISIONER_API_KEY
```

## 運用上の前提（未完・要対応）

このサービスは MVP スキャフォールド。本番稼働前に以下が必要：

1. **worker バンドルの供給** — `apps/worker` をビルドした成果物（単一 ES モジュール）を `WORKER_BUNDLE_URL` から取得できるようにする（CI で R2 へ publish 等）
2. **ASSETS のデプロイ** — L-harness worker は LIFF クライアントを ASSETS バインディングで配信する。Cloudflare の assets-upload-session フローが別途必要。MVP スキャフォールドでは未実装（設計ドキュメント §8 参照）
3. **R2 バインディング** — L-harness worker は画像用 R2（`IMAGES`）を使う。バケット作成＋バインディング追加が必要
4. **cron triggers** — L-harness worker は5分毎の cron を使う。デプロイ時の triggers 設定が必要
5. **Cloudflare Worker 数上限** — アカウントあたりの上限監視。上限が近づいたら Workers for Platforms への移行を検討

→ 1〜4 が揃うまで `/provision` の worker デプロイ部分は完走しない。D1 作成・スキーマ適用・冪等性チェックは実装済み。
