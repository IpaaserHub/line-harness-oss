# TKDir / YTDir × LINE Harness 統合設計

**作成日**: 2026-05-21
**ステータス**: 設計確定（実装中）
**関連**: Linear プロジェクト「LINE Harness 統合（OEM）」

---

## 1. ゴール

TKDir / YTDir のユーザーが、SaaS の管理画面の中から LINE 公式アカウントのマーケティング自動化（ステップ配信・セグメント配信・タグ・フォーム・自動化ルール）を構築できるようにする。

## 2. 確定した方針（2026-05-21 田中さん決定）

| 論点 | 決定 |
|---|---|
| プロビジョニング | **動的デプロイ** — アカウントごとに Cloudflare API で独立した Worker + D1 を自動生成 |
| UI 統合 | **iframe 埋め込み** — L-harness 管理画面を TKDir/YTDir の「LINE連携」タブにそのまま表示 |
| 課金 | **TKDir/YTDir 標準機能**（追加課金なし） |
| 利用主体 | **各アカウントが1つ持てる** — エンドユーザー・代理店・スーパー管理者、いずれも1アカウント=1 LINE インスタンス |
| 実装順 | **共通部分を先に** → TKDir / YTDir 両方に適用 |

## 3. アーキテクチャ全体像

```
┌─────────────────────────────────────────────────────────────┐
│ TKDir / YTDir（既存 SaaS、Clerk 認証 + Convex）              │
│                                                             │
│  ┌───────────────────────────┐                              │
│  │ 「LINE連携」タブ          │  ① 未連携 → [連携する]ボタン  │
│  │  ┌─────────────────────┐  │  ② 連携済 → iframe 表示       │
│  │  │ <iframe>            │  │                              │
│  │  │  L-harness 管理画面 │◄─┼─ postMessage で API キー注入  │
│  │  └─────────────────────┘  │                              │
│  └───────────────────────────┘                              │
│              │ ① プロビジョニング要求                        │
└──────────────┼──────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────┐
│ Provisioner（新規 Cloudflare Worker・WL社管理）              │
│  - CLOUDFLARE_API_TOKEN を保持                               │
│  - Cloudflare REST API を叩いて:                             │
│    1. D1 データベース作成 (lh-<accountId>)                   │
│    2. schema.sql を適用                                     │
│    3. L-harness Worker をデプロイ (lh-<accountId>)           │
│    4. API_KEY 等のシークレット生成・設定                    │
│  - 返り値: { workerUrl, apiKey }                             │
└──────────────┬──────────────────────────────────────────────┘
               ▼ 1アカウント = 1セット
┌─────────────────────────────────────────────────────────────┐
│ lh-<accountId>.workers.dev   ← 独立 Worker + 独立 D1         │
│  - LINE Webhook / API / LIFF / 管理画面アセット             │
│  - このアカウント専用。他アカウントと物理分離               │
└─────────────────────────────────────────────────────────────┘
```

## 4. コンポーネント

### 4.1 Provisioner（新規）

**役割**: 「LINE連携」要求を受けて、アカウント専用の L-harness インスタンス（Worker + D1）を払い出す。

**設置場所**: 専用の Cloudflare Worker（`apps/provisioner` として line-harness-oss リポジトリ内に置く）。TKDir / YTDir 両方から共通で呼べるよう独立サービスにする（= 「共通部分を先に」）。

**保持する秘密**: `CLOUDFLARE_API_TOKEN`（WL社 Cloudflare アカウントの、D1 作成 + Worker デプロイ権限を持つトークン）。`PROVISIONER_API_KEY`（TKDir/YTDir からの呼び出しを認証するための共有鍵）。

**主要エンドポイント**:

```
POST /provision
  認証: Authorization: Bearer <PROVISIONER_API_KEY>
  body: { accountId: string, label?: string }
  処理:
    1. 冪等性チェック — 既存なら既存の {workerUrl, apiKey} を返す
    2. Cloudflare API: D1 作成
       POST /accounts/{cfAccountId}/d1/database  { name: "lh-<accountId>" }
    3. Cloudflare API: schema.sql を D1 に適用
       POST /accounts/{cfAccountId}/d1/database/{dbId}/query  { sql: <schema> }
    4. Cloudflare API: Worker スクリプトをアップロード（事前ビルド済みバンドル）
       PUT /accounts/{cfAccountId}/workers/scripts/lh-<accountId>
       - multipart: メインモジュール + metadata（D1 バインディング, ASSETS, 環境変数）
    5. API_KEY を生成し Worker のシークレットとして設定
       PUT /accounts/{cfAccountId}/workers/scripts/lh-<accountId>/secrets
    6. 返却: { workerUrl: "https://lh-<accountId>.<subdomain>.workers.dev", apiKey }

POST /deprovision   — インスタンス削除（解約時）
GET  /status        — プロビジョニング状態の照会
```

**注意点**:
- Worker スクリプトの REST アップロードには**事前ビルド済みの worker バンドル**が要る。CI で `apps/worker` をビルドして成果物を Provisioner に同梱する（または R2 に置いて参照）。
- Cloudflare アカウントあたりの Worker 数上限に注意（プランによる）。上限監視を入れる。
- 失敗時ロールバック: D1 作成後に Worker デプロイが失敗したら D1 を削除。

### 4.2 iframe 認証ブリッジ（L-harness 側の改修）

**課題**: L-harness 管理画面は API キー認証（キーを localStorage に保存）。iframe で埋め込むと、ユーザーに毎回キーを手入力させたくない。

**解決**: 親フレーム（TKDir/YTDir）から `postMessage` で API URL + API キーを iframe に渡し、L-harness 管理画面がそれを受け取って自動ログインする。

**postMessage プロトコル**:
```
親（TKDir/YTDir）→ 子（L-harness iframe）:
  { type: "lh-auth", apiUrl: "https://lh-xxx.workers.dev", apiKey: "..." }

子 → 親（準備完了通知）:
  { type: "lh-ready" }
```

**L-harness 側の改修**（`apps/web`）:
- 起動時に `window.parent` からの `postMessage` を待ち受ける受信口を追加
- `event.origin` を許可リスト（TKDir/YTDir のドメイン）で検証
- 受け取った `apiUrl` / `apiKey` を既存の localStorage 機構にセットしてログイン状態にする
- iframe 外（直接アクセス）では従来どおりログインフォーム

**セキュリティ**:
- API キーを URL に乗せない（履歴・リファラ漏洩回避）。postMessage のみ
- `postMessage` は `targetOrigin` を明示。受信側は `event.origin` を検証
- iframe は `sandbox` 属性 + CSP `frame-ancestors` で TKDir/YTDir からのみ埋め込み可に

### 4.3 TKDir / YTDir「LINE連携」タブ

各アカウント（エンド / 代理店 / スーパー管理者）の管理画面に「LINE連携」タブを追加。

**状態による出し分け**:
- **未連携**: 説明 + 「LINE連携を始める」ボタン → Provisioner を呼ぶ → 完了後 iframe 表示
- **プロビジョニング中**: ローディング表示（数十秒）
- **連携済**: iframe で L-harness 管理画面を表示。postMessage で認証注入
- **失敗**: 再試行ボタン

**データモデル追加**（Convex）: アカウント（または組織）レコードに以下を保持
```
lineHarness: {
  status: "none" | "provisioning" | "active" | "failed",
  workerUrl?: string,
  apiKey?: string,        // 暗号化して保存推奨
  d1DatabaseId?: string,
  provisionedAt?: number,
}
```

## 5. セキュリティ設計

- **テナント分離**: 1アカウント = 独立 Worker + 独立 D1。物理分離なので L-harness 本体側の追加分離ロジックは不要（CORERULE §0）
- **Provisioner の秘密**: `CLOUDFLARE_API_TOKEN` は Provisioner Worker の secret のみ。TKDir/YTDir には渡さない
- **L-harness API キー**: TKDir/YTDir の Convex に暗号化保存。iframe へは postMessage でのみ渡す
- **Provisioner 呼び出し認証**: `PROVISIONER_API_KEY` 共有鍵 + 定数時間比較
- L-harness 本体は 2026-05 セキュリティ監査の修正済み（PR #1）

## 6. フェーズ分け

| Phase | 内容 | 依存 |
|---|---|---|
| 3-1 | iframe 認証ブリッジ（L-harness `apps/web` 改修） | なし（このPRで実施） |
| 3-2 | Provisioner サービス実装（`apps/provisioner`） | `CLOUDFLARE_API_TOKEN`（田中さん投入） |
| 3-3 | TKDir / YTDir「LINE連携」タブ + Convex データモデル | 3-1, 3-2 |
| 3-4 | 実機検証（テスト用 LINE 公式アカウント + Cloudflare） | 田中さんのアカウント |
| 3-5 | β（代理店2〜3社） | 3-4 |

## 7. 田中さんの作業が要る項目（自動化できない）

1. **`CLOUDFLARE_API_TOKEN` の発行** — D1 作成 + Worker デプロイ権限を持つ API トークンを Cloudflare ダッシュボードで発行し、Provisioner Worker の secret に設定
2. **Cloudflare アカウント ID** — Provisioner の環境変数に設定
3. **テスト用 LINE 公式アカウント** — 実機検証用（LINE Developers Console）
4. **本番デプロイ** — Provisioner Worker と関連リソースの本番公開

## 8. 未確定・将来検討

- Cloudflare Worker 数上限に達した場合の対応（Workers for Platforms へ移行 — dispatch namespace でマルチテナント Worker 配信、ただし上位プラン）
- L-harness 管理画面のホスティング: MVP は単一の共有 SPA を postMessage でパラメータ化。将来は各 Worker が自分の管理画面アセットも配信する自己完結型も検討
- iframe の UX 制約（画面サイズ・スクロール）が実用上問題になったら、UI を TKDir/YTDir ネイティブに段階移行（当初の案 C）
