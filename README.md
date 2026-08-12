# notion-rag-mcp

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fts-76%2Fnotion-rag-mcp)

Notion を巡回して D1・FTS・Vectorize に索引し、MCP から検索できる単一の Cloudflare Worker です。`staff-ai-toolkit` の Notion RAG と MCP 入口だけを独立させています。

このリポジトリ自体では Cloudflare リソースの作成やデプロイを行っていません。上のボタンを実行した人の Cloudflare アカウントでのみ、必要なリソースが作成されます。

## 含むもの・含まないもの

含むもの:

- Streamable HTTP の MCP エンドポイント (`/mcp`)
- Notion のページ・データベース巡回、ブロックのチャンク化、外部リンクの Markdown 取り込み
- Workers AI による埋め込み、D1/FTS と Vectorize を使うハイブリッド検索
- 再インデックスを分割・再試行する Cloudflare Workflows と定期実行

含まないもの:

- Firebase OAuth、組織・ロール別のアクセス制御、管理画面
- スキルレジストリ、プラグイン配布、アプリ作成レポート

MCP と管理用 REST エンドポイントは、Cloudflare Zero Trust Access で Worker 全体を保護する前提です。Worker 自身は認証を実装しないため、Access を適用せずに公開してはいけません。

## MCP ツール

| Tool | Purpose |
| --- | --- |
| `notion_search` | ベクトル・FTS・キーワードを組み合わせて検索する |
| `notion_get_page` | D1 に保存済みのページ全文を取得する |
| `notion_source_upsert` | ルート Notion ページを RAG ソースとして登録する |
| `notion_source_list` | 登録済みソースを確認する |
| `notion_reindex_start` | ソースの耐久的な再インデックスを開始する |
| `notion_reindex_status` | 再インデックスの進捗を取得する |

## Deploy to Cloudflare

上のボタンは、リポジトリを自分の GitHub アカウントへ複製し、Workers Builds でデプロイします。D1、Vectorize、Workers AI、Browser Rendering、Workflows のバインディングは `wrangler.jsonc` から作成・接続され、`deploy` スクリプトで D1 migration を適用してから Worker を公開します。

セットアップ画面では `NOTION_API_TOKEN` を入力します。この値は `.dev.vars.example` には含まれておらず、Worker secret として保存されます。Notion integration には対象のページ・データベースを共有してください。

この標準ボタンは公開 GitHub リポジトリ向けです。現時点の `ts-76/notion-rag-mcp` は非公開のため、第三者向けに配布する前に公開設定へ変更してください。この変更ではリポジトリの公開設定や Cloudflare リソースを変更していません。

デプロイ完了後、Worker 全体を Cloudflare Zero Trust Access で保護してください。Worker 内に共有シークレット認証はありません。

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

Workflows のページ処理を同一 Worker 内で分割するため、`NOTION_INDEX_SERVICE` はこの Worker 自身への Service Binding です。Worker を増やす構成ではありません。

## 既存環境からの切替

安全な初回切替では、索引データをコピーせず再構築します。

1. 現行の `notion_sources` を確認し、新環境で `notion_source_upsert` を実行する。
2. 各ソースで `notion_reindex_start` を実行し、新しい D1/Vectorize に全文を再作成する。
3. `notion_search` の結果、件数、再インデックス完了を検証する。
4. MCP クライアントの接続先を新 Worker の `/mcp` に変更する。
5. 問題があれば接続先だけを旧 Worker に戻す。旧環境は新環境の検証完了まで削除しない。

チャンク・FTS・Vectorize を再構築するため、旧環境の D1 全体を移設する必要はありません。これにより旧アプリ固有のユーザー、認証、スキル、配布テーブルを新リポジトリに持ち込まずに済みます。
