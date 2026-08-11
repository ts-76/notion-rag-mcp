# notion-rag-mcp

Notion を巡回して D1・FTS・Vectorize に索引し、MCP から検索できる単一の Cloudflare Worker です。`staff-ai-toolkit` の Notion RAG と MCP 入口だけを独立させています。

このリポジトリでは Cloudflare リソースの作成やデプロイを行っていません。`wrangler.jsonc` の D1 ID は、実際にプロビジョニングする段階で設定してください。

## 含むもの・含まないもの

含むもの:

- Streamable HTTP の MCP エンドポイント (`/mcp`)
- Notion のページ・データベース巡回、ブロックのチャンク化、外部リンクの Markdown 取り込み
- Workers AI による埋め込み、D1/FTS と Vectorize を使うハイブリッド検索
- 再インデックスを分割・再試行する Cloudflare Workflows と定期実行

含まないもの:

- Firebase OAuth、組織・ロール別のアクセス制御、管理画面
- スキルレジストリ、プラグイン配布、アプリ作成レポート

MCP と管理用 REST エンドポイントは `MCP_SHARED_SECRET` の bearer token で保護します。既存の Firebase/OAuth を必要に応じて後から追加できますが、この初期切り出しでは依存させません。

## MCP ツール

| Tool | Purpose |
| --- | --- |
| `notion_search` | ベクトル・FTS・キーワードを組み合わせて検索する |
| `notion_get_page` | D1 に保存済みのページ全文を取得する |
| `notion_source_upsert` | ルート Notion ページを RAG ソースとして登録する |
| `notion_source_list` | 登録済みソースを確認する |
| `notion_reindex_start` | ソースの耐久的な再インデックスを開始する |
| `notion_reindex_status` | 再インデックスの進捗を取得する |

## ローカル検証

```sh
bun install
bun run check
```

## 将来の Cloudflare セットアップ

デプロイを行う段階で、同じ Cloudflare アカウントに次の専用リソースを用意します。

1. D1 を作成して ID を `wrangler.jsonc` の `NOTION_RAG_DB` に設定する。
2. 1024 次元の Vectorize index を作成し、`NOTION_VECTORIZE` に設定する。埋め込みモデルを変更する場合は、次元数も必ず合わせる。
3. `NOTION_API_TOKEN` と `MCP_SHARED_SECRET` を Worker secret として設定する。
4. D1 migration を適用してから Worker を deploy する。

Workflows のページ処理を同一 Worker 内で分割するため、`NOTION_INDEX_SERVICE` はこの Worker 自身への Service Binding です。Worker を増やす構成ではありません。

## 既存環境からの切替

安全な初回切替では、索引データをコピーせず再構築します。

1. 現行の `notion_sources` を確認し、新環境で `notion_source_upsert` を実行する。
2. 各ソースで `notion_reindex_start` を実行し、新しい D1/Vectorize に全文を再作成する。
3. `notion_search` の結果、件数、再インデックス完了を検証する。
4. MCP クライアントの接続先を新 Worker の `/mcp` に変更する。
5. 問題があれば接続先だけを旧 Worker に戻す。旧環境は新環境の検証完了まで削除しない。

チャンク・FTS・Vectorize を再構築するため、旧環境の D1 全体を移設する必要はありません。これにより旧アプリ固有のユーザー、認証、スキル、配布テーブルを新リポジトリに持ち込まずに済みます。
