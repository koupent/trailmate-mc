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
| UI | ローカルダッシュボード | 設定・スポーン／デスポーン・ステータス |

## はじめ方

### 用意するもの

- Windows の場合: Docker Desktop（起動済み）
- 参加したい Minecraft Java サーバー（VPN 上でも可）
- オンラインモードのサーバーなら、ViaProxy 用の Microsoft アカウント（ボット専用）

### Docker とワールド参加は別です

- `start.bat` / `stop.bat` / `restart.bat` は **Docker コンテナだけ**を動かします
- 相棒が Minecraft ワールドに入るのは、ブラウザのダッシュボードで **スポーン** を押したときだけです
- コンテナが起動していても未スポーンなら、ワールドの時間は相棒のせいで進みません

```text
start.bat  →  コンテナ起動（未接続）
ダッシュボード「スポーン」  →  ワールドへ参加
ダッシュボード「デスポーン」  →  切断（コンテナは残る）
```

### Windowsでの初回セットアップ

1. Docker Desktop を起動し、起動完了まで待つ
2. 配布 ZIP またはこのリポジトリのフォルダーを開く
3. `start.bat` をダブルクリックする
4. ブラウザで [http://127.0.0.1:8787](http://127.0.0.1:8787) が開く（開かなければ手動でアクセス）
5. ダッシュボードで **サーバー住所** を保存する（オンラインなら Microsoft ログイン後のプロフィール名がワールド内名になります。オフラインならボット名を設定します）
6. オンラインサーバーなら **Microsoft ログイン** を実行する
7. **スポーン** を押す → サーバーに相棒が現れる

Windows 起動時に自動でコンテナを起こしたい場合:

1. Docker Desktop の設定で「サインイン時に Docker Desktop を起動」を有効にする
2. 必要ならスタートアップに `start.bat` を登録する
3. PC 起動後も相棒は **未スポーン** のままです。遊ぶときだけダッシュボードでスポーンしてください

### Microsoftアカウントの登録

オンラインモードのサーバーだけで必要です。オフライン（`auth-method: NONE`）なら不要です。

1. ダッシュボードの「Microsoft ログイン」で **ログイン開始** を押す
2. 画面に出た URL を開き、必要ならコードを入力する
3. **ボットとして使う Microsoft アカウント** でログインする
4. 画面が「登録完了: （プレイヤー名）」になれば成功（ViaProxy は自動再起動）
5. **スポーン** を押す

新しいPCでは `saves.json` が無いので、この手順が必須です。既存環境の `services/viaproxy/saves.json` をコピーしないでください（トークン漏洩の元になります）。

### macOS / Linuxでのセットアップ

```bash
cp .env.example .env
cp config.example.json config.json
cp services/viaproxy/viaproxy.yml.example services/viaproxy/viaproxy.yml
mkdir -p data
docker compose up -d --build
# ブラウザで http://127.0.0.1:8787 → 設定保存 → スポーン
```

### Windows バッチ

| ファイル | 用途 |
|---|---|
| `start.bat` | 設定ファイル作成 → コンテナ起動（未スポーン）→ ダッシュボードを開く |
| `stop.bat` | コンテナ停止 |
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

主な項目はダッシュボード（http://127.0.0.1:8787）からも編集できます。

- `.env` … ViaProxy への接続と、オフライン時のボット名（オンライン時のワールド内名は Microsoft プロフィール名）
- `config.json` … 追従距離、実況クールダウン、reflexes、死亡復帰 / 墓回収など
- `locales/ja.json` … 独り言・コマンド返答（英語を足すなら `locales/en.json`）
- `services/viaproxy/viaproxy.yml` … **実際の Minecraft サーバー**（`target-address`）

### 戦闘

`config.json` の `companion.reflexes` 配下:

| キー | 意味 | 既定 |
|---|---|---|
| `self_defense` | 近くの敵と自動で戦う | `true` |
| `hostile_range` | 敵を検知する距離（ブロック） | `12` |
| `combat_lost_grace_ms` | 護衛対象が一時的に外れても戦闘を維持する時間 | `1500` |
| `retreat_health` | （未使用・互換用）旧撤退体力閾値 | `8` |
| `resume_health` | （未使用・互換用）旧復帰体力閾値 | `14` |
| `retreat_distance` | （未使用・互換用）旧撤退距離 | `6` |
| `combat_learning.enabled` | 戦闘プリセットのオンライン学習 | `true` |
| `combat_learning.explore_rate` | プリセット探索率 | `0.12` |
| `combat_learning.min_trials` | 採用判定に必要な最低試行数 | `3` |
| `combat_learning.state_path` | 学習状態の保存先 | `data/combat-state.json` |

護衛は **Follow（追従）/ Guard（防衛）** が主モードです（低体力でも逃走Retreatには入りません）。プレイヤー近傍（既定8ブロック）の敵対モブ、またはBot至近（既定3.5ブロック）の敵を護衛対象とし、視野角は交戦の開始条件にしません。遠すぎる敵や壁越しの新規固定は避け、一度狙った敵は短い猶予時間だけ維持します。

- **Follow（追従）** … プレイヤーに付く（戦闘しない）
- **Guard（防衛）** … 護衛対象を優先して倒す／追い払う。複数敵がいるときは、敵の水平角度spanが狭くなる側へ横移動して囲まれを避ける

学習が有効なときは、敵の種類（近接 / 機敏 / 遠距離 / 爆発）と盾の有無ごとに安全な立ち回りプリセットを比較します。悪化した候補は自動で戻し、結果は `data/combat-state.json` に保存されます（敵数バケットは使いません）。

### ローカル戦闘箱庭（3D）

Minecraftを起動せず、**3Dボクセル箱庭**で戦闘を自動学習・監視します。旧2D平面表示は廃止済みです。

```bash
npx tsx src/simulator/server.ts
# ブラウザで http://127.0.0.1:4173
```

**監視画面の使い方**

1. 画面上部の **「学習を開始（放置OK）」** を押す（以降は放置でOK）
2. 新しい地形・敵が自動生成され、1戦ずつ学習 → 画面で観戦 → 次の戦へ進む
3. 相棒 HP が 0 になると **死亡して戦闘終了**（敵と同様）。勝利/敗北がエピソード結果になる
4. 「分析」欄で失敗クラスタを確認し、「Cursor用パックを書き出す」
5. パックを Cursor チャットに貼り、`src/combat/` のルール修正を依頼
6. 失敗シードのリプレイで目視確認 → `npm test -- tests/simulator.test.ts` → 実ワールド

手動のシナリオ読込・1 tick 操作は「手動デバッグ」に格納（通常は不要）。

**技術メモ**

- 判断は `threatArc` / `CombatIntent` / `CombatProfiles` を共有。表示は Three.js のみ（戦闘ロジックは持たない）
- 座標は XYZ。段差1段・落下・ブロックLOSを簡易再現。脅威弧は本番どおり水平XZ
- 回帰シナリオ: `single-ranged`、`multi-positioning`、`recovery`、動的3種、加えて `elevated-ranged` / `wall-los-block`
- 学習状態は箱庭専用の `data/sim-combat-state.json`（本番 `data/combat-state.json` とは分離）
- 失敗シードの再現例: `curl -s -X POST http://127.0.0.1:4173/api/gym/replay -H "content-type: application/json" -d "{\"seed\":1000}"`

戦闘改善の受け入れ順序:

1. **箱庭・テスト** — 自動ジムと固定シナリオで決定論的に確認する。
2. **Bot統合** — 合格した純粋ルールだけをMineflayer adapterへ接続する（`src/reflexes/combatPlanAdapter.ts` → `Reflexes`）。
3. **Minecraft動作確認** — 最後に実ワールドで移動・視線・被弾・攻撃を確認する。

実ワールド確認の目安:

- 純近接複数: 攻撃扇に晒されたとき回り込み、ノックバック後にヒット&アウェイしない
- スケルトン: 盾なしは回避バースト、接近後に殴る
- クリーパー: 未着火は処理、着火中だけ退避
- オーナー被弾: 襲撃者へ即フォーカス
- 学習 JSON は箱庭 `data/sim-combat-state.json` と本番 `data/combat-state.json` を混ぜない

### 死亡復帰・自分の墓・周辺ドロップ回収・余剰受け渡し・作業退避

`config.json` の `companion` 配下:

| キー | 意味 | 既定 |
|---|---|---|
| `awareness_radius` | 相棒が周囲のエンティティ／墓を把握する半径（SSOT） | `10` |
| `owner_work.enabled` | 武器・作業道具を持つ周囲のプレイヤー全員の視界外へ位置取る | `true` |
| `owner_work.all_players` | オーナー以外のプレイヤーの手持ち装備も対象にする | `true` |
| `owner_work.fov_degrees` | 位置取り判定に使うプレイヤー視界の水平角度 | `100` |
| `death_return.enabled` | リスポーン後に死亡座標へ戻る | `true` |
| `death_return.arrive_range` | 到着とみなす距離（ブロック） | `3` |
| `death_return.timeout_ms` | 復帰を諦めるまでの時間 | `90000` |
| `own_grave.enabled` | 近くの自分の墓を壊す | `true` |
| `own_grave.dig_range` | 墓破壊に入る距離 | `3.5` |
| `nearby_loot.enabled` | 周辺の地面ドロップを拾う | `true` |
| `nearby_loot.radius` | 拾いに行く半径（ブロック） | `8` |
| `nearby_loot.recovery_radius` | 墓由来ドロップを追跡する半径 | `12` |
| `nearby_loot.recovery_capture_ms` | 墓破壊後に墓由来entity IDを確定する時間 | `1000` |
| `nearby_loot.recovery_deadline_ms` | 緊急回避でも延長しないRecovery回収期限 | `12000` |
| `nearby_loot.recovery_quiet_ms` | owned ID消失後の安定待ち | `750` |
| `nearby_loot.max_ms` | 1回の拾いの上限時間 | `15000` |
| `nearby_loot.quiet_ms` | ドロップが消えてから終了するまでの待ち | `1500` |
| `nearby_loot.grace_ms` | 拾い開始直後の出現待ち | `2500` |
| `nearby_loot.give_suppress_ms` | 全回収・余剰受け渡し後に再拾いしない時間 | `12000` |
| `torch_light_threshold` | この明るさ以下で松明を置く（近くの松明と日光から推定）。上げるほど松明が増える | `7` |
| `item_share.enabled` | オーナーがBot前方に置いたチェストへ余剰アイテムを収納する | `true` |
| `item_share.keep_torch_stacks` | 手元に残す松明の合計スタック数 | `2` |
| `item_share.keep_food_stacks` | 手元に残す安全な食料の合計スタック数 | `2` |
| `item_share.keep_weapon_stacks` | 手持ち中を含めて残す近接武器の合計数 | `2` |
| `item_share.keep_equipment_sets` | 装備中を含めて残す防具各部位・盾ごとの合計数 | `2` |

挙動の要点:

1. **死亡復帰**・**墓破壊**・**周辺ドロップ回収**は別ロジックです。墓は壊すだけ、散らばったアイテムや探索中のドロップは `nearby_loot` が拾います。
2. チャットで状況を知らせます（例: `死亡地点へ戻るよ (x, y, z)` / `自分の墓を見つけたよ (x, y, z)`）。
3. 墓はホログラム等の表示名から持ち主を判定します。ボット自身のユーザー名と一致しない墓、名前が読めない墓は**壊しません**（他人の墓破壊によるゾンビ出現を防ぐため）。
4. ViaProxy 経由などで名前表示が読めない環境では、安全のため墓は破壊しません（死亡座標への移動と地面ドロップの拾得のみ有効）。
5. ネザー / エンドなど**別ワールド種別**への自動ポータル移動はしません。同じワールド種別に戻った時点で死亡復帰を続けます。
6. 通常の `nearby_loot` は `awareness_radius` 内のドロップを拾い続けます。Recoveryでは墓破壊前の既存IDを除外し、破壊直後の短い取得期間で確定した墓由来IDだけを優先します。無関係なドロップはRecoveryを妨げず、通常収集へ戻った後に扱います。
7. オーナーを含む周囲のプレイヤーが、剣・斧・弓・クロスボウなどの武器、またはツルハシ・シャベル・クワ・ハサミなどの作業道具を手に持っている間は、対象者全員の現在の視界と近接範囲を避ける位置で追従します。腕を振る前や弓を引く前から有効になり、対象外のアイテムへ持ち替えると即時解除します。死亡復帰・墓回収中は例外で回収を続けます。全回収・余剰受け渡し直後は `give_suppress_ms` の間拾いません。
8. `item_share` は、追従中のロック済みオーナーがBotの前方にチェストを置いたとき、そのチェストへ余剰を収納します。防具の各部位・盾・近接武器は装備中を含めて合計2個、食料と松明は合計2スタックを残し、弓・クロスボウ・矢を含むそれ以外を収納します。チャットの「全回収」は従来どおり全アイテムをプレイヤーへ渡します。
9. 追従オーナーが通常ボートまたは竹のいかだの操縦席へ先に乗り、空席がある場合、相棒は3ブロック以内から2番目の座席へ同乗します。同乗中は相棒から操縦入力を出さず、オーナーの下船・座席順の変化・ボート消失時は相棒も下船して通常追従へ戻ります。チェスト付き・満席のボートには乗りません。

**秘密情報（`.env`、実 `viaproxy.yml`、`saves.json`）はコミットしないでください。**

## うまく動かないとき

1. `status.bat` でコンテナ状態を確認する（またはダッシュボードのログ）
2. Docker Desktop が起動しているか確認する
3. ダッシュボードでサーバー住所がプレースホルダのままになっていないか確認する
4. スポーンしてもすぐ切れる場合、オンラインモードなら Microsoft ログインをやり直す
5. ダッシュボード（http://127.0.0.1:8787）が開かない → `docker compose ps` で `dashboard` が Up か確認
6. `.bat` が意味不明なエラーで即終了する → 改行が LF になっている可能性。再クローンするか `.gitattributes` 適用後に `git add --renormalize "*.bat"`

### Windows 起動直後にスポーンが失敗する（自動で直します）

Windows 起動時は Docker Desktop が Tailscale より先に立ち上がることがあります。
その順番で起動した ViaProxy は接続先サーバーへ一度も届かないまま動き続け、
待ち受けポートは開いているので healthy に見えるのに、スポーンだけが
`Could not connect to the backend server!` で失敗します。

ダッシュボードがこれを見張って自動でつなぎ直すので、`restart.bat` は不要です。

- 接続先サーバーに届かない時間帯があった後、届くようになったら ViaProxy を1回だけ再起動します（スポーン中は行いません）
- スポーンがこのエラーで失敗した場合も、ViaProxy をつなぎ直してから自動で1回やり直します

つなぎ直し中はダッシュボードに「ViaProxy をつなぎ直しています…」と出ます。終わればそのままスポーンできます。

## 更新（GitHub Release）

タグ `v*` を push すると Actions が次を公開します。

- GHCR イメージ（`trailmate-mc` / `trailmate-dashboard`）
- Windows 用 ZIP（展開して `start.bat`）

### ダッシュボードから更新（推奨）

1. http://127.0.0.1:8787 の **運用** タブを開く
2. 「更新を確認」で現在バージョンと最新 Release を比較する
3. 「更新する」を押す（スポーン中の相棒は再起動されます）
4. 画面が切れたら再読み込みする

イメージ（`trailmate` / `dashboard`）とローカルの `VERSION` が更新されます。設定・認証データはそのまま残ります。

### 注意

- 更新源は **GitHub Release のみ** です（`main` へのマージだけでは他 PC には届きません）
- GHCR パッケージが private だと pull に失敗します。配布するなら public にしてください
- `docker-compose.yml` / `start.bat` などホスト側ファイルの変更がある Release は、ZIP を再展開してください（Release ノートに記載）
- 手動で更新する場合: `docker compose pull` のあと `restart.bat`

## 開発

```bash
npm install
cp config.example.json config.json
# ViaProxy が立っている前提でローカル起動も可（起動直後はパーク）
npm start
# 別端末でスポーン:
# curl -X POST http://127.0.0.1:8790/spawn

npm test
# ソースをコンテナにマウントして試す場合:
# docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## ライセンス

MIT。Mindcraft 由来部分の帰属は [NOTICE](NOTICE) を参照。
