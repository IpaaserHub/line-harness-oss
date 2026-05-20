# LINE Harness — WL社フォーク

LINE 公式アカウント向けの CRM / マーケティングオートメーション。**Cloudflare Workers + Hono + D1 (SQLite)** で動く OSS（本家 `Shudesu/line-harness-oss`、MIT）の WL社フォーク。
TKDir / YTDir のオプション機能として、**ユーザーごとに独立インスタンスを払い出して**統合する（OEM 連携）。

## 共通ルール

Claude Code は、実装・調査・レビュー・PR 作成の前に必ず [`CORERULE.md`](./CORERULE.md) を読むこと。

`CORERULE.md` は **Codex / Claude Code 共通のコーディング規約・設計原則の single source of truth**。共通原則を変更する場合は `CLAUDE.md` と `AGENTS.md` に重複記載せず、原則として `CORERULE.md` を更新する。

Codex 側の入口は [`AGENTS.md`](./AGENTS.md) とし、同じ `CORERULE.md` を参照する。

## デプロイモデル（WL社フォーク固有）

**1テナント = 独立した Cloudflare Worker + 独立した D1 データベース。** 複数テナントで同一インスタンスを共有しない。
このため L-harness 本体側にテナント横断のデータ分離ロジックを足す必要はない（物理的に分離済み）。詳細は `CORERULE.md` §0。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| API / Webhook | Cloudflare Workers + Hono |
| データベース | Cloudflare D1 (SQLite) |
| 管理画面 | Next.js（静的エクスポート）— `apps/web` |
| LIFF クライアント | Vite + TypeScript — `apps/worker/src/client` |
| SDK | TypeScript — `packages/sdk` |
| LINE 連携 | `packages/line-sdk`（Messaging API ラッパー + 署名検証） |
| 定期実行 | Workers Cron Triggers |

## コードマップ

```
apps/
  worker/          # Cloudflare Workers API (Hono)
    src/
      index.ts       # エントリ・ルートマウント
      middleware/    # auth / rate-limit / role-guard
      routes/        # API ルート（webhook / liff / forms / stripe / users ...）
      services/      # ビジネスロジック（broadcast / step-delivery / event-bus ...）
      utils/         # 共通関数（timing-safe / line-id-token ...）
      client/        # LIFF クライアント（Vite ビルド）
  web/             # Next.js 管理画面
packages/
  db/              # D1 スキーマ + クエリヘルパー + migrations
  sdk/             # TypeScript SDK
  line-sdk/        # LINE Messaging API ラッパー（署名検証含む）
  shared/          # 共有型定義
  mcp-server/      # Claude Code 連携用 MCP サーバー
```

## upstream との関係

- **upstream**: `Shudesu/line-harness-oss`（OSS 本家）
- **origin**: `IpaaserHub/line-harness-oss`（WL社フォーク）
- WL社独自変更は最小・局所的に保ち、upstream の更新を定期的に取り込む
- **作業ブランチは常に最新の `main` を土台にする**（古いスナップショット上で作業を積み上げない）

## マストルール

- **タスク開始前に `CORERULE.md` を確認**: 実装前に必ずコーディング規約・セキュリティ・パフォーマンスのガイドラインを読む
- **セキュリティは fail-closed**: Webhook 署名検証・ID トークン検証・権限ガードを省略しない。詳細は `CORERULE.md` §4・§7
- **D1 は prepared statement のみ**: SQL に文字列補間しない。`CORERULE.md` §5
- **`CLAUDE.md` は最小限に保つ**: 共通規約は `CORERULE.md` に置き、ここには重複記載しない
