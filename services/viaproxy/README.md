# ViaProxy（Trailmate MC 用）

Trailmate MC ボットを、Mineflayer が直接話しにくいサーバーバージョンへつなぐためのプロキシです。

## 設定ファイル

初回はリポジトリ直下の `start.bat` が `viaproxy.yml.example` から `viaproxy.yml` を作ります。
または手動で:

```bash
cp services/viaproxy/viaproxy.yml.example services/viaproxy/viaproxy.yml
```

必ず `target-address` を、参加したい Minecraft サーバーに書き換えてください。

```yaml
bind-address: 0.0.0.0:25568
target-address: your-server.example.com:25565
```

- Trailmate（ボット）は `.env` の `MC_HOST` / `MC_PORT` で **ViaProxy** に接続します（通常は `viaproxy:25568`）
- 実サーバーの住所は **ここ（`target-address`）だけ** に書きます

`viaproxy.yml` と `saves.json` は gitignore 済みです。共有しないでください。

## 起動

リポジトリ直下で:

```bash
docker compose up -d viaproxy
```

Windows なら `start.bat` が ViaProxy と Trailmate をまとめて起動します。

## サーバーの認証方式

### オフラインモードのサーバー

Microsoftアカウントの登録は不要です。`viaproxy.yml` を次のように変更します。

```yaml
auth-method: NONE
```

### オンラインモードのサーバー

正規のMinecraft Java版を所有するMicrosoftアカウントが必要です。初心者向けの詳しい登録操作は、ルートの [README](../../README.md#microsoftアカウントの登録) を参照してください。

最初の1件を登録すると、そのアカウントは番号 `0` として保存されます。exampleは最初から次の設定なので、通常は編集不要です。

```yaml
auth-method: ACCOUNT
minecraft-account-index: 0
```

登録後にViaProxyを再起動すると、番号 `0` のアカウントが使われます。`account select 0` は実行しなくても構いません。

## 複数のアカウントを登録した場合

この操作が必要なのは、Microsoftアカウントを2件以上登録し、1件目以外を使いたい場合だけです。

1. ViaProxyへアタッチする

```bash
docker attach trailmate-mc-viaproxy-1
```

2. 登録済みアカウントと番号を表示する

```text
account list
```

3. 使用したいアカウントの番号を確認する（例: `1`）
4. `Ctrl+P`、続けて `Ctrl+Q` でデタッチする
5. `viaproxy.yml` の番号を書き換える

```yaml
auth-method: ACCOUNT
minecraft-account-index: 1
```

6. `restart.bat` を実行する

`account select <番号>` は、起動中のViaProxyで選択を切り替えるコマンドです。このプロジェクトでは、再起動後も選択を維持できる `minecraft-account-index` を使います。

> [!WARNING]
> Microsoft ログインすると `saves.json` にトークンが保存されます。
> このファイルを共有すると、他人がそのアカウントでサーバーに入れます。

## トラブルシュート

| 症状 | 確認すること |
|---|---|
| `start.bat` が target-address を編集せよと止まる | example のまま。実サーバーに変更して再実行 |
| ViaProxy がすぐ終了する | 初回自動生成後は再起動が必要な場合あり。`viaproxy.yml` を確認して再起動 |
| `requires a valid authentication mode` | オンラインモード。Microsoftアカウントを登録して再起動 |
| Trailmate が `ECONNRESET` | `target-address` が間違っている／サーバー未起動／認証未設定 |
| healthcheck 失敗 | `docker compose logs viaproxy` を確認 |
