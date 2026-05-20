## コア原則

このファイルは **Codex / Claude Code 共通のコーディング規約・設計原則の single source of truth**。
実装・調査・レビュー・PR 作成の前に必ず確認し、入口ファイルの `AGENTS.md` / `CLAUDE.md` には同じ規約を重複記載しない。

LINE Harness は **Cloudflare Workers + Hono + D1 (SQLite)** で動く LINE 公式アカウント CRM（OSS 本家は MIT）。
このリポジトリは WL社フォーク。**アクセシブル・高性能・型安全・保守性の高い**コードを書く。簡潔さより明確さと意図の明示を重視。

---

## 0. デプロイモデル（最重要・WL社フォーク固有）

WL社では **「1テナント = 独立した Cloudflare Worker + 独立した D1 データベース」** で運用する。複数テナントで同一 Worker / D1 を共有しない。

- **テナント横断のデータ分離ロジックを新規に足さない** — テナントは物理的に別インスタンスなので分離は担保済み
- 環境変数・シークレットはテナントごとに `wrangler secret` で個別管理
- 「マルチアカウント」(= 1テナントが複数の LINE 公式アカウントを持つ) 機能は維持する。これは*テナント横断ではない*
- upstream（OSS 本家）の更新を取り込めるよう、WL社独自変更は**最小・局所的**にする

---

## 1. 型安全性と明示性

- 関数のパラメータと戻り値には明確さを高める型を使用
- 型が不明な場合は `any` より `unknown` を優先
- 不変値には `as const` を使用
- 型アサーションより型ナローイングを活用
- マジックナンバーは避け、説明的な名前の定数に抽出（金額・日数・閾値・タイムアウト等）

## 2. モダン JavaScript/TypeScript

- コールバックや短い関数にはアロー関数を使用
- `.forEach()` やインデックス付き `for` より `for...of` を優先
- `?.` と `??` で安全なプロパティアクセス
- 文字列連結よりテンプレートリテラル
- オブジェクト・配列の分割代入を活用
- `const` をデフォルトに、再代入が必要な場合のみ `let`、`var` は使わない

## 3. 非同期処理

- async 関数内では必ず Promise を `await`
- Promise チェーンより `async/await` で可読性向上
- 非同期コードでは try-catch で適切にエラー処理
- Promise executor に async 関数を使わない
- `crypto.subtle` は非同期 API。Workers では同期版の暗号 API はない

## 4. セキュリティ（このプロジェクトの絶対規則）

> セキュリティ修正は常に **fail-closed**（疑わしきは拒否）に倒す。下記は監査（`SECURITY_AUDIT_*.md`）で確立した規則。

- **Webhook ハンドラは署名を検証してから処理する。** 検証は**定数時間比較**（`apps/worker/src/utils/timing-safe.ts` の `timingSafeEqual`）。**生ボディ**（`c.req.text()`）に対して検証し、`JSON.parse` はその後に行う
- **シークレット未設定の Webhook は「素通り」させず拒否（fail-closed）。** dev 便宜のためのバイパス（secret 無しなら検証スキップ等）を作らない
- **公開エンドポイント（LIFF / フォーム送信等）はクライアント申告の `lineUserId` / `friendId` を信用しない。** LINE Login ID トークンを検証し（`apps/worker/src/utils/line-id-token.ts` の `verifyLineIdToken`）、`verified.sub` と申告された identity の一致を必須にする
- **認証バイパスリスト**（`apps/worker/src/middleware/auth.ts`）に新しいパスを追加するときは、そのルートが署名検証や ID トークン検証で**自前防御している**ことを必ず確認する
- **変更系 API（POST/PUT/DELETE）には `requireRole` で権限ガード**をかける。読み取り専用ルートは無ガード可。「POST だが読み取り専用」のルートは判断して扱う
- **秘密情報の比較（API キー・シークレット・署名）は必ず定数時間。** `===` での比較は禁止（先頭バイトから1バイトずつ漏洩するタイミング攻撃に脆弱）
- ユーザー入力は境界で検証・サニタイズ。LLM や外部 API に渡す前にもサニタイズ
- `target="_blank"` には `rel="noopener"`、`dangerouslySetInnerHTML` は必要な場合のみ、`eval()` は使わない

## 5. D1 (SQLite) データアクセス

- 全クエリは **prepared statement**（`db.prepare(sql).bind(...)`）。SQL 文字列にユーザー入力を補間しない
- 動的 `UPDATE` / `WHERE` を組むときは、**ハードコードされた SQL 断片**（`'name = ?'` 等）を配列に push して `join` し、値は `bind` で渡す。`Object.keys(body)` 由来の文字列を SQL に入れない
- テーブル名・カラム名・`ORDER BY` など bind できない部分を動的にする場合は**ホワイトリスト**で検証
- `db.exec()` は schema 定数にのみ使用。動的内容を渡さない
- スキーマ変更は `packages/db/migrations/` にマイグレーションを追加し `wrangler` で適用

## 6. Cloudflare Workers / Hono 固有

- ルートは `apps/worker/src/routes/`、横断処理は `src/middleware/`、ビジネスロジックは `src/services/`、共通関数は `src/utils/`
- Hono のルートにミドルウェアをチェーンすると path param の型推論が `string | undefined` に広がることがある → `c.req.param('id')!` で明示（既存 `routes/line-accounts.ts` のパターンに合わせる）
- Worker の **isolate はリクエスト間・コロ間で状態を共有しない**。インメモリ `Map` をレート制限などの永続状態に使わない（Durable Objects / KV を使う）
- ミドルウェアのマウント順序を意識する（CORS → rate-limit → auth → routes）

## 7. LINE プラットフォーム連携

- LINE Messaging Webhook は `X-Line-Signature` を HMAC-SHA256 で検証（`packages/line-sdk` の `verifySignature`）
- Stripe Webhook は `Stripe-Signature` を検証し、タイムスタンプ許容（300秒）でリプレイを防ぐ。`v1` 署名は複数あり得るので全てを照合
- LIFF からの操作は ID トークン検証で本人確認する。クライアントは `liff.getIDToken()` を `lineUserId` と**同送**し、トークンが取れないときは識別子を送らず**匿名フォールバック**（401 を出さない）
- 無効署名に対して `200 OK` を返さない（攻撃検知を妨げる）。適切な 4xx/5xx を返す

## 8. エラー処理とデバッグ

- 本番コードからデバッグ用の `console.log` / `debugger` を削除（構造化ログ・運用ログは可）
- 文字列ではなく説明的なメッセージ付きの `Error` オブジェクトを throw
- try-catch は意味のある場所で使用（再 throw だけなら不要）
- ネストした条件分岐より早期リターンを優先

## 9. 並列実装

- 独立したタスクが複数ある場合は並列エージェント（`superpowers:dispatching-parallel-agents`）を活用
- 依存関係のないファイル編集・ツール呼び出しは逐次でなく並列で行う

## 10. コード構成

- 関数は単一責任で認知複雑度を抑える
- 複雑な条件は名前付きの boolean 変数に抽出
- 早期リターンでネストを削減
- ネストした三項演算子より単純な条件分岐
- 関連コードをグループ化し、関心を分離

## 11. 管理画面 (Next.js) / LIFF クライアント (Vite)

管理画面 `apps/web` は Next.js（静的エクスポート）、LIFF クライアント `apps/worker/src/client` は Vite ビルド。React を書くときは:

- クラスコンポーネントより関数コンポーネント
- フックはトップレベルでのみ呼び出し、依存配列を正確に
- イテラブル要素には配列インデックスでなくユニーク ID の `key`
- セマンティック HTML と ARIA（alt テキスト、見出し階層、フォームラベル、キーボードイベント併用）
- API キーを `localStorage` に置くのは XSS リスク。新規の秘密情報の保存場所は慎重に設計

## 12. パフォーマンス

- ループ内のアキュムレータでスプレッド構文を避ける
- 正規表現はループ内で生成せずトップレベルで定義
- 名前空間インポートより具体的なインポート
- バレルファイル（全てを re-export する index）を避ける

## 13. レビュー / PR / upstream 同期

- マージ前は型チェック・テスト・lint・CI を通す（`pre-merge-audit` skill 相当）
- WL社独自変更は upstream（`Shudesu/line-harness-oss`）の更新を取り込めるよう局所的に保つ
- 長期間 upstream を取り込まないと大きくドリフトする。**作業ブランチは常に最新の `main` を土台にする**（古いスナップショット上で作業を積み上げない）
