# notion-rag-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fts-76%2Fnotion-rag-mcp)

Notion を巡回して D1・FTS・Vectorize に索引し、MCP から検索できる単一の Cloudflare Worker です。`staff-ai-toolkit` の Notion RAG と MCP 入口だけを独立させています。

このリポジトリ自体では Cloudflare リソースの作成やデプロイを行っていません。上のボタンを実行した人の Cloudflare アカウントでのみ、必要なリソースが作成されます。

## 含むもの・含まないもの

含むもの:

- Streamable HTTP の MCP エンドポイント (`/mcp`、MCP 2026-07-28 と従来の2025系クライアントに対応)
- Notion のページ・データベース巡回、ブロックのチャンク化、外部リンクの Markdown 取り込み
- Workers AI による埋め込み、D1/FTS と Vectorize を使うハイブリッド検索
- 再インデックスを分割・再試行する Cloudflare Workflows と定期実行

含まないもの:

- Firebase OAuth、組織・ロール別のアクセス制御、管理画面
- スキルレジストリ、プラグイン配布、アプリ作成レポート

MCP と管理用 REST エンドポイントは `@cloudflare/workers-oauth-provider` により OAuth 2.1 で保護され、Cloudflare Access for SaaS を上流 IdP として使用します。`/health` だけは未認証で公開されます。

> **費用に関する注意:** Cloudflare Zero Trust Access の Free プランは 50 ユーザーまでです。51 ユーザー以上で利用する場合は有料プランが必要で、従量課金プランは現在 1 ユーザーあたり月額 7 米ドルです。Workers、D1、Vectorize などの利用料金はこれとは別に発生し得ます。料金は変更されるため、導入前に [Cloudflare Zero Trust の料金ページ](https://www.cloudflare.com/plans/zero-trust-services/) を確認してください。

## MCP ツール

| Tool | Purpose |
| --- | --- |
| `notion_search` | ベクトル・FTS・キーワードを組み合わせて検索する |
| `notion_get_page` | D1 に保存済みのページ全文を取得する |
| `notion_source_upsert` | ルート Notion ページを RAG ソースとして登録する |
| `notion_source_list` | 登録済みソースを確認する |
| `notion_reindex_start` | ソースの耐久的な再インデックスを開始する |
| `notion_reindex_status` | 再インデックスの進捗を取得する |

## 公式Notion MCPとの比較

公式Notion MCPは、各メンバーがOAuthで接続し、自分のNotion権限の範囲で最新のページを検索・取得・更新するためのホスト型MCPです。個人の作業や、Notionを直接更新するワークフローに向いています。

`notion-rag-mcp` は、組織で選定したページやデータベースを専用のNotion Integrationに共有し、検索用の索引として運用します。メンバーにはIntegration Tokenを配らず、Cloudflare Accessで保護した単一のMCPエンドポイントを提供します。

| 観点 | notion-rag-mcp | 公式Notion MCP |
| --- | --- | --- |
| 認証と権限 | 専用IntegrationとCloudflare Access。Integrationに共有した情報だけを対象にできる | 各メンバーがOAuthで接続し、そのメンバーのNotion権限で動作する |
| 検索 | チャンク化、ベクトル検索、FTSを組み合わせて検索する | Notionの最新コンテンツを直接検索する |
| データの鮮度 | 索引後に反映される。更新は再インデックスまたは定期実行に依存する | Notionの最新状態を参照する |
| 操作範囲 | 検索・ページ取得・索引管理に限定する | 検索・取得に加え、ページ作成や更新も行える |
| 運用 | Cloudflareリソース、索引、Accessポリシーを運用する | Notionがホストし、インフラ運用は不要 |
| 向く用途 | 承認済みの社内ナレッジを、安定した検索対象として提供したい場合 | 個人のNotionを調べたり、ページを直接編集したりしたい場合 |

公式Notion MCPの接続方法と対応ツールは、[Notion公式ドキュメント](https://developers.notion.com/guides/mcp/overview) および [対応ツール一覧](https://developers.notion.com/guides/mcp/mcp-supported-tools) を参照してください。

## Deploy to Cloudflare

上のボタンは、リポジトリを自分の GitHub アカウントへ複製し、Workers Builds でデプロイします。D1、Vectorize、Workers AI、Browser Rendering、Workflows のバインディングは `wrangler.jsonc` から作成・接続され、`deploy` スクリプトで D1 migration を適用してから Worker を公開します。

Workers Builds のコマンドは、Build command を `bun run build`、Deploy command を `bun run deploy` に設定してください。`build` スクリプトは `wrangler deploy --dry-run` でWorkerをコンパイル・検証し、実際の公開とD1 migrationは `deploy` スクリプトだけが行います。現行Wranglerには `wrangler build` コマンドはありません。

セットアップ画面では `NOTION_API_TOKEN` と後述の Access OAuth secrets を入力します。これらの値はリポジトリには含めず、Worker secret として保存します。Notion integration には対象のページ・データベースを共有してください。

この標準ボタンは公開 GitHub リポジトリ向けです。現時点の `ts-76/notion-rag-mcp` は非公開のため、第三者向けに配布する前に公開設定へ変更してください。

## Cloudflare Access OAuth

1. Zero Trust ダッシュボードで **Access for SaaS > Generic OIDC** アプリケーションを作成する。
2. Callback URL に本番の `https://<worker-host>/callback` を設定する。ローカル検証も行う場合は `http://localhost:8787/callback` も追加する。
3. OAuth state・grant・token 用の KV namespace を作成し、出力された ID を `wrangler.jsonc` の `OAUTH_KV` に設定する。
4. Access for SaaS アプリに表示される Client ID、Client secret、Authorization URL、Token URL、JWKS URL を Worker secrets に設定する。
5. Cookie 署名鍵には十分に長いランダム値を設定する。

```sh
bunx wrangler kv namespace create OAUTH_KV
bunx wrangler secret put ACCESS_CLIENT_ID
bunx wrangler secret put ACCESS_CLIENT_SECRET
bunx wrangler secret put ACCESS_AUTHORIZATION_URL
bunx wrangler secret put ACCESS_TOKEN_URL
bunx wrangler secret put ACCESS_JWKS_URL
openssl rand -hex 32 | bunx wrangler secret put COOKIE_ENCRYPTION_KEY
```

OAuth provider は `/authorize`、`/callback`、`/register`、`/token` と discovery metadata を公開します。有効な bearer token がない `/mcp`、`/sources`、`/reindex-jobs` への要求は拒否されます。Access の include/exclude ポリシーで、利用を許可するユーザーまたはグループを制限してください。

## ローカル検証

```sh
bun install
bun run lint:secrets
bun run check
```

## 将来の Cloudflare セットアップ

デプロイを行う段階で、同じ Cloudflare アカウントに次の専用リソースを用意します。

1. D1 を作成して ID を `wrangler.jsonc` の `NOTION_RAG_DB` に設定する。
2. 1024 次元の Vectorize index を作成し、`NOTION_VECTORIZE` に設定する。埋め込みモデルを変更する場合は、次元数も必ず合わせる。
3. `NOTION_API_TOKEN` を Worker secret として設定する。
4. D1 migration を適用してから Worker を deploy する。

Deploy to Cloudflare ボタンではこの準備を対話形式で行えます。Wrangler を直接使う場合は、リソース作成と ID 設定後に `bun run deploy` を実行します。

ページ処理は `NOTION_INDEX_WORK_ITEM_WORKFLOW` を通じて同一 Worker の Workflow entrypoint に分割されます。デプロイ先の Worker 名に依存する Service Binding は使用しません。

## 既存環境からの切替

安全な初回切替では、索引データをコピーせず再構築します。

1. 現行の `notion_sources` を確認し、新環境で `notion_source_upsert` を実行する。
2. 各ソースで `notion_reindex_start` を実行し、新しい D1/Vectorize に全文を再作成する。
3. `notion_search` の結果、件数、再インデックス完了を検証する。
4. MCP クライアントの接続先を新 Worker の `/mcp` に変更する。
5. 問題があれば接続先だけを旧 Worker に戻す。旧環境は新環境の検証完了まで削除しない。

チャンク・FTS・Vectorize を再構築するため、旧環境の D1 全体を移設する必要はありません。これにより旧アプリ固有のユーザー、認証、スキル、配布テーブルを新リポジトリに持ち込まずに済みます。
