/**
 * Display names for companion states. Keys stay the state ids.
 * Unknown ids are shown as-is so a new state is visible before it is translated.
 *
 * `bundledFsmStates` is copied into this file because the dashboard image
 * bakes `public/` and does not ship `locales/`. It must match
 * `locales/ja.json` `fsm_states`. The API still wins when that key is present.
 */
export const bundledFsmStates = {
  normal: { label: '平常', note: 'モードに従って動く' },
  planting: { label: '作物を植える', note: '追従モードのときだけ' },
  combat: { label: '戦闘', note: '敵に対処する' },
  passage_transit: { label: '扉・ゲート通過', note: '開けて通って閉める' },
  loot: { label: 'アイテム回収', note: '落ちている物を拾いに行く' },
  death_recovery: { label: '死亡からの復帰', note: '死亡地点・墓へ戻る' },
  stuck_recovery: { label: 'スタック復帰', note: '穴や詰まりから抜ける' },
  hazard_escape: { label: '危険回避', note: '炎・危険ブロック・水' },
  boat_passenger: { label: 'ボート同乗', note: '操作せず乗っている' },
  item_transfer: { label: '受け渡し', note: '渡す・チェストに預ける' },
  any: { label: 'どの状態からでも', note: '' },
  follow: { label: '追従', note: 'オーナーについていく' },
  wait: { label: '待機', note: 'その場で待つ' }
};

export function stateLabel(fsmStates, id) {
  return fsmStates?.[id]?.label || id;
}

export function stateNote(fsmStates, fsm, id) {
  if (id === 'normal' && fsm?.preferredMode) {
    return `${stateLabel(fsmStates, fsm.preferredMode)}モードの動き`;
  }
  return fsmStates?.[id]?.note ?? id;
}
