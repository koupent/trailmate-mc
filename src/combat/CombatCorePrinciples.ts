/**
 * 戦闘ロジックの書き換え禁止大原則。
 *
 * 学習・箱庭チューニングではパラメータ微調整のみ可。
 * 下記の構造・優先順位を変える変更は、明示的なユーザー承認なしに行わないこと。
 *
 * 保護手段:
 * - 本ファイルと CombatIntent / SimulationCore の CORE コメント
 * - `.cursor/rules/combat-core-principles.mdc`
 * - `tests/combat_core_principles.test.ts`（破壊すると CI / npm test が落ちる）
 */

export const COMBAT_CORE_PRINCIPLES = {
  threatArcNarrowing: {
    id: 'threat-arc-narrowing',
    summary:
      '複数脅威では、危険扇の分布に応じて位置取りする。'
      + '攻撃扇に晒されている間は、扇を狭める回り込みを接近・回避より優先する。'
      + '種別は扇の半径・半角の違いだけ。遠距離1体でも／近接が複数寄ってきても同じ。'
      + '基本は最寄り敵へ回り込み、他敵の方位を重ねる。学習用の目標扇角パラメータには依存しない。'
      + '危険扇露出中は局所最小まで狭窄を続け、途中で attack に切り替えて中断しない（歩き殴りは可）。'
      + '扇に晒されていないときは近い危険への打撃／接近を優先する（届かない＝狭窄、にはしない）。'
  },
  rangedWithoutShield: {
    id: 'ranged-without-shield',
    summary:
      '盾なしで遠距離圧があるときは回避バーストを行い、前進中の新規被弾でも短い再回避を挟む。'
      + '近接一歩手前まで詰めたら前進を優先してよい。'
  },
  rangedWithShield: {
    id: 'ranged-with-shield',
    summary:
      '盾ありで遠距離圧があるときは guard を優先し、箱庭では遠距離被弾を大きく軽減する。'
      + '盾がない前提の一直線突撃にしてはならない。'
  }
} as const;

export type CombatCorePrincipleId =
  (typeof COMBAT_CORE_PRINCIPLES)[keyof typeof COMBAT_CORE_PRINCIPLES]['id'];
