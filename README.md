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
- 死亡後、同じワールド種別なら死亡座標へ戻り、近くのドロップを拾う
- 半径10ブロック以内の**自分の名前付き墓**（GravesX 等）を壊して中身を回収する
- 建築は壊さない方針（掘削・足場なし。例外は自分の墓だけ）
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

- Windows の場合: Docker Desktop（起動済み）
- 参加したい Minecraft Java サーバー（VPN 上でも可）
- オンラインモードのサーバーなら、ViaProxy 用の Microsoft アカウント

### Windowsでの初回セットアップ

プログラミングに慣れていない方でも進められる手順です。

#### 1. 設定ファイルを自動作成する

1. Docker Desktopを起動し、起動完了まで待つ
2. このリポジトリのフォルダーを開く
3. `start.bat` をダブルクリックする
4. 黒い画面に `ACTION REQUIRED` と表示されたら、何かキーを押して閉じる

初回は設定ファイルを作成するために停止します。これはエラーではありません。

#### 2. Minecraftサーバーの住所を設定する

1. `services` → `viaproxy` フォルダーを開く
2. 作成された `viaproxy.yml` をメモ帳などで開く
3. `target-address:` で始まる行を探す
4. その行を参加先サーバーの住所とポートに書き換え、保存する

```yaml
# 設定例
target-address: your-server.example.com:25565
```

一般的なポート番号は `25565` です。接続先が分からない場合は、サーバー管理者に「サーバーアドレスとポート番号」を確認してください。

#### 3. もう一度起動する

`start.bat` をもう一度ダブルクリックします。

- ボットがサーバーに現れた場合: **セットアップ完了**
- Microsoftアカウントが必要という警告が表示され、ボットが現れない場合: 次の登録手順へ進む

### Microsoftアカウントの登録

#### この作業が必要か判断する方法

次のどちらかに当てはまる場合だけ必要です。

- サーバー管理者から「オンラインモードのサーバー」と案内されている
- `start.bat` の最後に、Microsoftアカウントが必要という警告が表示された

ボットがすでにサーバーへ参加できている場合、この作業は不要です。

#### 登録手順

1. リポジトリのフォルダーをエクスプローラーで開く
2. 上部のアドレス欄に `powershell` と入力し、Enterを押す
3. 開いた画面に次のコマンドを貼り付け、Enterを押す

```bash
docker attach trailmate-mc-viaproxy-1
```

4. 続けて次を入力し、Enterを押す

```text
account add microsoft
```

5. 表示されたURLをブラウザーで開く
6. コードが表示されている場合は、そのコードを入力する
7. **ボットとして使うMicrosoftアカウント**でログインし、完了表示を確認する
8. PowerShellへ戻り、`Ctrl` を押しながら `P`、続けて `Ctrl` を押しながら `Q` を押す
9. PowerShellが通常の入力待ちに戻ったら閉じる
10. `restart.bat` をダブルクリックする
11. Minecraftサーバーにボットが現れれば完了

> **重要:** `Ctrl+C` は使わないでください。ViaProxy自体が停止することがあります。

#### `account select 0` は必要？

通常は必要ありません。

- 初めて登録した1件目のアカウントには番号 `0` が付く
- 初期設定の `minecraft-account-index: 0` が、そのアカウントを再起動時に使用する
- そのため、1件だけ登録する通常の使い方では `account select 0` を実行しなくてもよい

複数のアカウントを登録した場合だけ、使用する番号の変更が必要です。詳しくは [ViaProxyの詳細設定](services/viaproxy/README.md#複数のアカウントを登録した場合) を参照してください。

> **注意:** ログイン情報は `services/viaproxy/saves.json` に保存されます。このファイルを他人に送ったり、Gitへコミットしたりしないでください。

### macOS / Linuxでのセットアップ

Windows用バッチは利用できないため、ターミナルで設定ファイルを作成します。

```bash
cp .env.example .env
cp config.example.json config.json
cp services/viaproxy/viaproxy.yml.example services/viaproxy/viaproxy.yml
# viaproxy.yml の target-address を編集してから起動
docker compose up -d --build
```

### Windows バッチ

| ファイル | 用途 |
|---|---|
| `start.bat` | 設定の自動作成 → ViaProxy / Trailmate 起動 |
| `stop.bat` | 停止 |
| `restart.bat` | 停止してから起動 |
| `status.bat` | コンテナ状態と直近ログ |

> **注意:** `.bat` は Windows の `cmd.exe` 用です。改行は CRLF である必要があります（`.gitattributes` で固定）。

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
- `config.json` … 追従距離、実況クールダウン、reflexes、死亡復帰 / 墓回収など
- `locales/ja.json` … 独り言・コマンド返答（英語を足すなら `locales/en.json`）
- `services/viaproxy/viaproxy.yml` … **実際の Minecraft サーバー**（`target-address`）

### 戦闘

`config.json` の `companion.reflexes` 配下:

| キー | 意味 | 既定 |
|---|---|---|
| `self_defense` | 近くの敵と自動で戦う | `true` |
| `hostile_range` | 敵を検知する距離（ブロック） | `8` |
| `combat_lost_grace_ms` | 敵が一時的に隠れても戦闘を維持する時間 | `2500` |
| `retreat_health` | 撤退を始める体力 | `8` |
| `resume_health` | 戦闘を再開できる体力 | `14` |
| `retreat_distance` | 持ち主が不在時に敵から離れる距離 | `6` |

戦闘中は敵への接近を優先し、追従経路との切り替わりを防ぎます。低体力時は持ち主の近くへ撤退し、持ち主が見つからない場合は敵と反対方向へ退きます。また、遠距離攻撃を行う敵には距離を詰め、起爆中のクリーパーからは盾がなければ離れます。

### 死亡復帰・自分の墓・周辺ドロップ回収・余剰受け渡し・作業退避

`config.json` の `companion` 配下:

| キー | 意味 | 既定 |
|---|---|---|
| `awareness_radius` | 相棒が周囲のエンティティ／墓を把握する半径（SSOT） | `10` |
| `owner_work.enabled` | オーナー作業中に視界外へ退避する | `true` |
| `owner_work.fov_degrees` | 退避判定に使うオーナー視界の水平角度 | `100` |
| `owner_work.swing_idle_ms` | スイング停止後、作業終了とみなすまでの待ち | `1000` |
| `owner_work.post_work_cooldown_ms` | 作業終了後も視界外を維持する時間 | `4000` |
| `death_return.enabled` | リスポーン後に死亡座標へ戻る | `true` |
| `death_return.arrive_range` | 到着とみなす距離（ブロック） | `3` |
| `death_return.timeout_ms` | 復帰を諦めるまでの時間 | `90000` |
| `own_grave.enabled` | 近くの自分の墓を壊す | `true` |
| `own_grave.dig_range` | 墓破壊に入る距離 | `3.5` |
| `nearby_loot.enabled` | 周辺の地面ドロップを拾う | `true` |
| `nearby_loot.max_ms` | 1回の拾いの上限時間 | `15000` |
| `nearby_loot.quiet_ms` | ドロップが消えてから終了するまでの待ち | `1500` |
| `nearby_loot.grace_ms` | 拾い開始直後の出現待ち | `2500` |
| `nearby_loot.give_suppress_ms` | 全回収・余剰受け渡し後に再拾いしない時間 | `12000` |
| `torch_light_threshold` | この明るさ以下で松明を置く（近くの松明と日光から推定）。上げるほど松明が増える | `7` |
| `item_share.enabled` | 余剰アイテムをオーナーへ定期的に渡す | `true` |
| `item_share.interval_ms` | 受け渡し判定の間隔 | `60000` |
| `item_share.keep_torch_stacks` | 手元に残す松明のスタック数 | `3` |
| `item_share.keep_food_stacks` | 手元に残す食料のスタック数 | `3` |
| `item_share.keep_equipment_sets` | 装備部位ごとに残すセット数（装備中含む） | `3` |

挙動の要点:

1. **死亡復帰**・**墓破壊**・**周辺ドロップ回収**は別ロジックです。墓は壊すだけ、散らばったアイテムや探索中のドロップは `nearby_loot` が拾います。
2. チャットで状況を知らせます（例: `死亡地点へ戻るよ (x, y, z)` / `自分の墓を見つけたよ (x, y, z)`）。
3. 墓はホログラム等の表示名から持ち主を判定します。ボット自身のユーザー名と一致しない墓、名前が読めない墓は**壊しません**（他人の墓破壊によるゾンビ出現を防ぐため）。
4. ViaProxy 経由などで名前表示が読めない環境では、安全のため墓は破壊しません（死亡座標への移動と地面ドロップの拾得のみ有効）。
5. ネザー / エンドなど**別ワールド種別**への自動ポータル移動はしません。同じワールド種別に戻った時点で死亡復帰を続けます。
6. `awareness_radius` 内のドロップは基本すべて拾います。オーナーが採掘・設置などで腕を振っている間は視界外（後方）へ退避し、作業終了後も `post_work_cooldown_ms` の間は戻らず回収 interrupt も止めます。振り向いただけでは退避しません。死亡復帰・墓回収中は例外で回収を続けます。全回収・余剰受け渡し直後は `give_suppress_ms` の間拾いません。ドロップ回収は墓破壊より優先し、散らばったアイテムの取りこぼしを減らします。
7. `item_share` はロック済みオーナーが近く、戦闘・回収中でないときに余剰を渡します。松明・食料は各指定スタック、装備は部位ごとに性能上位の指定セット数を残し、それ以外を渡します。チャットの「全回収」は従来どおり全アイテムを渡します。

**秘密情報（`.env`、実 `viaproxy.yml`、`saves.json`）はコミットしないでください。**

## うまく動かないとき

1. `status.bat` でコンテナ状態を確認する
2. Docker Desktop が起動しているか確認する
3. `viaproxy.yml` の `target-address` がプレースホルダのままになっていないか確認する
4. ViaProxy 初回だけ設定生成後に一度終了することがある → `target-address` を直して `start.bat` を再実行
5. Trailmate がすぐ落ち、ViaProxy ログに `requires a valid authentication mode` と出る
   → オンラインモードのサーバーです。上記の **Microsoft アカウント登録** を行い、`auth-method: ACCOUNT` のまま `restart.bat`
6. `.bat` が意味不明なエラーで即終了する → 改行が LF になっている可能性。再クローンするか `.gitattributes` 適用後に `git add --renormalize "*.bat"`

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
