/**
 * ダッシュボードの「相棒の設定」に出す項目の定義。
 *
 * 画面はこの定義から組み立てるので、項目を増やすときはここに 1 行足すだけでよい。
 * 値は config.json の `path` に保存され、次のスポーンから反映される。
 */

import { DEFAULT_COMPANION } from '../config.js';

export type SettingField = {
  /** config.json 内のドット区切りパス。 */
  path: string;
  label: string;
  help?: string;
  kind: 'bool' | 'number';
  /** 画面表示 = 保存値 × scale（ミリ秒→秒、確率→% など）。 */
  scale?: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 普段は触らない項目。「詳細」に折りたたむ。 */
  advanced?: boolean;
};

export type SettingSection = { title: string; fields: SettingField[] };
/** id は画面側の分類タブ（dashboard/public/index.html の data-settings-panel）と対応する。 */
export type SettingCategory = { id: string; sections: SettingSection[] };

const sec = (label: string, path: string, min = 0, max = 600, extra: Partial<SettingField> = {}): SettingField =>
  ({ path, label, kind: 'number', scale: 0.001, unit: '秒', min, max, step: 0.1, ...extra });
const pct = (label: string, path: string, extra: Partial<SettingField> = {}): SettingField =>
  ({ path, label, kind: 'number', scale: 100, unit: '%', min: 0, max: 100, step: 1, ...extra });
const num = (label: string, path: string, min: number, max: number, unit: string, extra: Partial<SettingField> = {}): SettingField =>
  ({ path, label, kind: 'number', min, max, step: 1, unit, ...extra });
const bool = (label: string, path: string, extra: Partial<SettingField> = {}): SettingField =>
  ({ path, label, kind: 'bool', ...extra });

export const SETTING_CATEGORIES: SettingCategory[] = [
  {
    id: 'movement',
    sections: [
      {
        title: 'ついていく距離',
        fields: [
          num('ついていく距離', 'companion.follow_distance', 1, 16, 'ブロック', { help: 'これより離れると追いかけます。' }),
          num('最小距離', 'companion.follow_min_distance', 1, 16, 'ブロック', { help: 'これより近づきません。' }),
          num('近くにいるとみなす距離', 'companion.owner_near_radius', 2, 48, 'ブロック', { advanced: true }),
          num('詰まり判定までの時間', 'companion.stuck_detect_seconds', 0.5, 10, '秒', { step: 0.1, advanced: true })
        ]
      },
      {
        title: '作業の邪魔をしない',
        fields: [
          bool('プレイヤーの作業中は視界から外れる', 'companion.owner_work.enabled'),
          bool('オーナー以外のプレイヤーにも配慮する', 'companion.owner_work.all_players'),
          num('作業視界の広さ', 'companion.owner_work.fov_degrees', 30, 180, '度', { advanced: true })
        ]
      }
    ]
  },
  {
    id: 'combat',
    sections: [
      {
        title: '戦闘',
        fields: [
          bool('敵と戦う', 'companion.reflexes.self_defense'),
          num('敵に反応する距離', 'companion.reflexes.hostile_range', 4, 48, 'ブロック'),
          num('オーナーを守る範囲', 'companion.reflexes.owner_protect_range', 2, 48, 'ブロック', { help: 'オーナーからこの距離内の敵を倒しに行きます。' }),
          sec('見失ってから諦めるまで', 'companion.reflexes.combat_lost_grace_ms', 0, 30, { advanced: true })
        ]
      },
      {
        title: '撤退',
        fields: [
          bool('体力が減ったら撤退する', 'companion.reflexes.self_preservation'),
          num('撤退する体力', 'companion.reflexes.retreat_health', 1, 19, 'HP'),
          num('戦闘に戻る体力', 'companion.reflexes.resume_health', 2, 20, 'HP'),
          num('撤退する距離', 'companion.reflexes.retreat_distance', 2, 32, 'ブロック', { advanced: true })
        ]
      },
      {
        title: '食事',
        fields: [
          num('体力が満タンのとき、食べ始める満腹度', 'companion.auto_eat.healthy_start_at', 0, 19, '以下'),
          num('体力が減っているとき、食べ始める満腹度', 'companion.auto_eat.injured_start_at', 0, 19, '以下', { help: '満腹度 18 以上で体力が自然回復するため、高めにしています。' })
        ]
      },
      {
        title: '戦い方の学習',
        fields: [
          bool('戦い方を自分で調整する', 'companion.reflexes.combat_learning.enabled'),
          pct('新しい戦い方を試す頻度', 'companion.reflexes.combat_learning.explore_rate'),
          num('評価に必要な試行回数', 'companion.reflexes.combat_learning.min_trials', 1, 50, '回', { advanced: true }),
          num('試すのに必要な体力', 'companion.reflexes.combat_learning.min_health_to_explore', 1, 20, 'HP', { advanced: true }),
          num('試すのをやめる被ダメージ', 'companion.reflexes.combat_learning.explore_damage_abort', 1, 20, 'HP', { advanced: true })
        ]
      }
    ]
  },
  {
    id: 'items',
    sections: [
      {
        title: '落ちているアイテムを拾う',
        fields: [
          bool('近くのアイテムを拾う', 'companion.nearby_loot.enabled'),
          num('拾いに行く範囲', 'companion.nearby_loot.radius', 1, 32, 'ブロック'),
          bool('すぐ近くのアイテムは移動中でも拾う', 'companion.nearby_loot.collector_enabled'),
          num('移動中に拾う範囲', 'companion.nearby_loot.collector_radius', 1, 16, 'ブロック', { advanced: true }),
          num('死亡後に回収する範囲', 'companion.nearby_loot.recovery_radius', 1, 32, 'ブロック', { advanced: true }),
          sec('1 回の回収にかける時間', 'companion.nearby_loot.max_ms', 0.5, 60, { advanced: true }),
          sec('受け取った直後に拾わない時間', 'companion.nearby_loot.give_suppress_ms', 0, 120, { advanced: true })
        ]
      },
      {
        title: 'チェストに預ける',
        fields: [
          bool('置いたチェストにアイテムを預ける', 'companion.item_share.enabled'),
          bool('預けた結果を報告する', 'companion.item_share.notify_enabled'),
          bool('攻撃を受けたら預けるのを中断する', 'companion.item_share.abort_on_recent_damage', { advanced: true }),
          bool('中断した預け入れを再開する', 'companion.item_share.resume_enabled', { advanced: true }),
          sec('再開を待つ時間', 'companion.item_share.resume_expire_ms', 0, 600, { advanced: true }),
          num('再開を試す回数', 'companion.item_share.resume_max_attempts', 0, 20, '回', { advanced: true })
        ]
      }
    ]
  },
  {
    id: 'chat',
    sections: [
      {
        title: '会話',
        fields: [
          bool('ゲーム内チャットで話す', 'chat_ingame'),
          bool('自分から話しかける', 'companion.chat.enabled'),
          pct('話しかける頻度', 'companion.chat.spontaneous_chance'),
          pct('何もないときに話す頻度', 'companion.chat.idle_chance'),
          pct('戦闘中に話す頻度', 'companion.chat.combat_commentary_chance'),
          sec('発言の最短間隔', 'companion.chat.min_interval_ms', 0, 600, { advanced: true }),
          sec('重要な発言の最短間隔', 'companion.chat.priority_min_interval_ms', 0, 600, { advanced: true }),
          sec('同じ話題を繰り返さない時間', 'companion.chat.event_cooldown_ms', 0, 1800, { advanced: true }),
          sec('返事の間隔', 'companion.chat.player_reply_cooldown_ms', 0, 60, { advanced: true }),
          num('体力が少ないと言う体力', 'companion.chat.low_health', 1, 20, 'HP', { advanced: true }),
          num('詰まったと言うまでの時間', 'companion.chat.stuck_seconds', 1, 60, '秒', { advanced: true }),
          num('敵の接近を知らせる距離', 'companion.chat.hostile_range', 4, 48, 'ブロック', { advanced: true }),
          num('持ち物の空きを知らせ直す空き数', 'companion.chat.inventory_fill_rearm_slots', 1, 36, 'スロット', { advanced: true })
        ]
      },
      {
        title: '目が合ったときの反応',
        fields: [
          bool('目が合ったら反応する', 'companion.eye_contact.enabled'),
          pct('反応して話す頻度', 'companion.eye_contact.chat_chance'),
          num('反応する距離', 'companion.eye_contact.max_distance', 1, 32, 'ブロック', { advanced: true }),
          sec('目が合ったとみなす時間', 'companion.eye_contact.dwell_ms', 0, 10, { advanced: true }),
          sec('次に反応するまでの時間', 'companion.eye_contact.cooldown_ms', 0, 600, { advanced: true })
        ]
      }
    ]
  },
  {
    id: 'recovery',
    sections: [
      {
        title: '死亡したとき',
        fields: [
          bool('死亡地点へ戻る', 'companion.death_return.enabled'),
          bool('自分の墓を回収する', 'companion.own_grave.enabled'),
          num('到着とみなす距離', 'companion.death_return.arrive_range', 1, 16, 'ブロック', { advanced: true }),
          sec('戻るのを諦めるまで', 'companion.death_return.timeout_ms', 5, 600, { advanced: true }),
          num('墓に手が届く距離', 'companion.own_grave.interact_range', 1, 6, 'ブロック', { step: 0.5, advanced: true })
        ]
      }
    ]
  },
  {
    id: 'world',
    sections: [
      {
        title: '松明',
        fields: [
          bool('暗い場所に松明を置く', 'companion.reflexes.torch_placing'),
          num('松明を置く明るさ', 'companion.torch_light_threshold', 0, 15, '以下', { help: 'この明るさ以下で置きます。' })
        ]
      },
      {
        title: '畑',
        fields: [bool('オーナーの近くの畑に種を植え直す', 'companion.crop_replant.enabled')]
      },
      {
        title: '周囲の把握',
        fields: [
          num('周囲を調べる範囲', 'companion.scan_radius', 8, 128, 'ブロック', { advanced: true }),
          num('アイテムや墓に気づく範囲', 'companion.awareness_radius', 2, 48, 'ブロック', { advanced: true }),
          num('視野角', 'companion.fov_degrees', 30, 360, '度', { advanced: true })
        ]
      }
    ]
  }
];

const DEFAULTS = { chat_ingame: true, companion: DEFAULT_COMPANION };

export function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<any>((value, key) => (value == null ? undefined : value[key]), source);
}

export type SchemaField = SettingField & { default: unknown };
export type SchemaCategory = { id: string; sections: Array<{ title: string; fields: SchemaField[] }> };

/** ダッシュボードに渡す定義（各項目の既定値付き）。 */
export function settingsSchema(): SchemaCategory[] {
  return SETTING_CATEGORIES.map((category) => ({
    ...category,
    sections: category.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => ({ ...field, default: readPath(DEFAULTS, field.path) }))
    }))
  }));
}
