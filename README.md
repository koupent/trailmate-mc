# Trailmate MC

*Trailmate MC* は Minecraft 向けのルールベース **探索相棒**です。LLM は使いません。

ワールドに「もう一人のプレイヤー」として入り、追従・護衛・松明・短い実況で旅に付き合います。

```text
あなた ──► Minecraft サーバー
Trailmate MC ──► ViaProxy ──► 同じサーバー
```

## できること

- 視界に入ったプレイヤーをオーナーとして追従
- チャットコマンド: `待機` / `追従` / `全回収` / `拠点`
- 敵が近づいたら戦う・暗所に松明・空腹で食べる（ルールベース）
- 状態（距離・HP・敵名・昼夜など）を反映した独り言（定型カタログ）
- 建築は壊さない方針（掘削・足場なし）
- 持ち主または自分で開けた木の扉・フェンスゲートは、通過後に閉める

## 技術スタック（なぜこうか）

| 層 | 選択 | 理由 |
|---|---|---|
| ボット API | Mineflayer + pathfinder 等 | 追従・戦闘エコシステムが最大 |
| 言語 | TypeScript (Node 22) | 薄いホストで再構築しやすい |
| プロトコル橋 | ViaProxy | 最新 Paper 等へ当面つなぐため |
| 会話 | `locales/*.json` | 実行時翻訳 API / LLM なし。愛着のある文を意図的に書ける |
| UI | なし | ログとゲーム内チャットのみ |

## はじめ方

### 用意するもの

- Docker Desktop
- 参加したい Minecraft Java サーバー（VPN 上でも可）
- ViaProxy 用の Microsoft アカウント（オンラインサーバーの場合）

### セットアップ

```bash
cp .env.example .env
cp config.example.json config.json
cp services/viaproxy/viaproxy.yml.example services/viaproxy/viaproxy.yml
```

1. `viaproxy.yml` の `target-address` を実サーバーに変更
2. ViaProxy にアカウントを登録（`docker compose up -d viaproxy` → `docker attach`）
3. Windows なら `start.bat`、それ以外は:

```bash
docker compose up -d --build
```

### チャットコマンド

詳細: [docs/commands.md](docs/commands.md)

| 言葉 | 動作 |
|---|---|
| `待機` | その場で待つ |
| `追従` | 発言者についていく |
| `全回収` | 持ち物をすべて渡す |
| `拠点` | 現在地をスポーン地点に（OP が必要な場合あり） |

## 設定

- `.env` … 接続先（ViaProxy）とボット名
- `config.json` … 追従距離、実況クールダウン、reflexes など
- `locales/ja.json` … 独り言・コマンド返答（英語を足すなら `locales/en.json`）

**秘密情報（`.env`、実 `viaproxy.yml`、`saves.json`）はコミットしないでください。**

## 開発

```bash
npm install
cp config.example.json config.json
# ViaProxy が立っている前提でローカル起動も可
npm start
npm test
```

## ライセンス

MIT。Mindcraft 由来部分の帰属は [NOTICE](NOTICE) を参照。
