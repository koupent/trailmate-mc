import { Vec3 } from 'vec3';
import path from 'node:path';
import type { Bot } from 'mineflayer';
import { isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import {
  DEFAULT_PROTECT_RANGES,
  isProtectThreat,
  pickProtectTarget,
  type OwnerThreatHint,
  type ProtectRanges
} from '../world/threatPolicy.js';
import { projectRoot, type ReflexConfig } from '../config.js';
import {
  baselinePresetId,
  classifyEnemy,
  countNearbyHostiles,
  getPresetParams,
  isRangedEntity,
  type CombatContext,
  type CombatPresetParams
} from '../combat/CombatProfiles.js';
import {
  movementControlsTowardBearing,
  perpendicularDodgeBearing,
  threatBearingRad
} from '../combat/threatArc.js';
import { CombatEpisodeTracker } from '../combat/CombatEpisodeTracker.js';
import { CombatOptimizer } from '../combat/CombatOptimizer.js';
import { CombatStateStore } from '../combat/CombatStateStore.js';
import { CombatTrace } from '../combat/CombatTrace.js';
import { isCreeperIgnited, CREEPER_STRIKE_GAP_MS } from '../combat/creeperTactics.js';
import {
  collectTacticalThreatObservations,
  DEFAULT_TACTICAL_OBSERVATION_RADIUS,
  type TacticalThreatObservation
} from '../combat/TacticalObservation.js';
import { jumpBlockedByFarmland } from '../companion/movement/farmland.js';
import { applyCombatStepAssist } from '../combat/combatStepAssist.js';
import {
  combatOwnsControl,
  refreshCombatControlUntil
} from '../combat/TacticalOwnership.js';
import {
  decideCombatStep,
  type CombatMemory,
  type CombatScene,
  type CombatStep
} from '../combat/CombatStep.js';
import { FOCUS_STICKY_MS, MELEE_STRIKE_GAP_MS, STRAFE_SWITCH_MS } from '../combat/CombatParams.js';
import { buildLiveCombatScene } from './liveCombatScene.js';
import {
  action,
  condition,
  runTree,
  selector,
  sequence
} from '../companion/behaviorTree/bt.js';
import {
  estimateBrightness,
  nearestTorchDistance,
  torchScanRadius,
  TORCH_PLACE_COOLDOWN_MS,
  type LightSample
} from './torchPlacement.js';
import { isTorchItemName } from '../companion/utils/itemClassify.js';

type DefendOwnerEntity = {
  position: {
    x: number;
    y: number;
    z: number;
    offset: (x: number, y: number, z: number) => any;
    distanceTo?: (other: { x: number; y: number; z: number }) => number;
  };
  height?: number;
};
type DefendOwner = DefendOwnerEntity | null | undefined;

type CombatMovement = {
  followEntity: (entity: any, range: number) => boolean;
  goToward: (position: { x: number; y: number; z: number }, range?: number) => boolean;
  climbTo?: (position: { x: number; y: number; z: number }, holdMs?: number) => boolean;
  setSprintAllowed?: (allowed: boolean) => void;
  stop?: () => void;
};

type RecoveryContext = {
  active: boolean;
  phase?: string;
  collectionCaptureUntil?: number;
  collectionDeadlineAt?: number;
  ownedItemIds?: number[];
  ownedItemIdsFrozen?: boolean;
  emergencyUntil?: number;
  emergencyCooldownUntil?: number;
};

/** Reflexesが公開する上位護衛行動。 */
export type EscortMode = 'follow' | 'guard';

const TARGET_RANGE_BUFFER = 2;
/** 戦闘の移動目標に到着したとみなす距離。 */
const COMBAT_GOAL_RANGE = 0.75;
/** 相棒の1tick（companion.tick_ms と箱庭の tickMs に合わせる）。 */
const COMBAT_TICK_MS = 250;
/** 1tickでこれ未満しか進まなければ詰まりとみなす（箱庭と同じ）。 */
const STUCK_PROGRESS = 0.1;
/** 被弾後に自己防衛を維持する猶予（ms）。 */
const RECENT_DAMAGE_GRACE_MS = 4000;
/** オーナー被弾直後に recentDamageUntil を延長する判定窓（ms）。 */
const OWNER_THREAT_FRESH_MS = 1500;

type TraceEntity = {
  id: number | string | null;
  name: string | null;
  position: object;
  distance: number | null;
  bearingDeg: number | null;
};

/**
 * 護衛相棒のReflexes。
 *
 * 何をするかは箱庭と共通の判断（CombatStep）が決め、ここは観測の用意と
 * Mineflayer での実行（移動・打撃・盾・視線）を担う。戦闘中の1tickは
 * ビヘイビアツリー `combatTree` として実行され、ダッシュボードに表示される。
 */
export class Reflexes {
  private lastTorchAt = 0;
  private fighting = false;
  private mode: EscortMode = 'follow';
  private currentTarget: any | null = null;
  private lastTargetSeenAt = 0;
  private lastHealth: number;
  private strafeSign: 1 | -1 = 1;
  private strafeUntil = 0;
  private activePresetParams: CombatPresetParams = getPresetParams(baselinePresetId({
    enemyClass: 'melee',
    hasShield: false
  }));
  private activePresetId = baselinePresetId({
    enemyClass: 'melee',
    hasShield: false
  });
  private activeContextKey = '';
  /** 護衛対象（currentTarget）を同じ優先度の別の敵へ切り替えない期間。 */
  private focusUntil = 0;
  private readonly episodeTracker = new CombatEpisodeTracker();
  private readonly combatOptimizer: CombatOptimizer;
  private readonly combatStore: CombatStateStore;
  private readonly combatTrace: CombatTrace;
  /** 防衛中に最後に確認したowner（角度leash用）。 */
  private lastDefendOwner: DefendOwner = null;
  /** 被弾後の短時間は自己防衛を強制する。 */
  private recentDamageUntil = 0;
  private lastDamageAt = 0;
  /** 対象が一瞬消えても、戦闘が移動・視線所有権を短時間維持する。 */
  private combatControlUntil = 0;
  private lastCombatLookAt = 0;
  private lastTracePosition: { x: number; z: number; at: number } | null = null;
  /** Recoveryは上位目標であり、戦闘側は短い生存行動だけ割り込める。 */
  private recoveryOwned = false;
  private recoveryEmergencyWasActive = false;
  private lastRecoveryDamageHandledAt = 0;
  /** ownerThreatTracker が記録したオーナー被弾情報。 */
  private lastOwnerThreat: OwnerThreatHint = null;
  /** このtickの護衛対象がオーナーの襲撃者として固定されている。 */
  private ownerThreatLocked = false;
  /** 共通判断がtickをまたいで保つ状態。 */
  private combatMemory: CombatMemory = {};
  private combatTick = 0;
  /** このtickの判断。 */
  private step: CombatStep | null = null;
  private combatMovement: CombatMovement | undefined;
  /** 戦闘が pathfinder に目標を出している。 */
  private combatGoalIssued = false;
  /** 前tickで移動を出した位置（詰まり判定用）。 */
  private lastMovePos: { x: number; z: number } | null = null;
  private lastStrikeAt = 0;
  private shieldRaised = false;
  /** 戦闘中の1tick。ダッシュボードの戦闘ステートに表示される。 */
  readonly combatTree = this.buildCombatTree();

  constructor(
    private readonly bot: Bot,
    private readonly config: ReflexConfig,
    private readonly torchLightThreshold: number
  ) {
    this.lastHealth = Number.isFinite(bot.health) ? bot.health : 20;
    this.combatTrace = new CombatTrace();
    this.combatTrace.event('enabled', {
      heartbeatMs: this.combatTrace.heartbeatMs
    });
    const learning = config.combat_learning;
    const statePath = path.isAbsolute(learning.state_path)
      ? learning.state_path
      : path.join(projectRoot(), learning.state_path);
    this.combatStore = new CombatStateStore(statePath);
    if (learning.enabled && learning.seed_path) {
      const seedPath = path.isAbsolute(learning.seed_path)
        ? learning.seed_path
        : path.join(projectRoot(), learning.seed_path);
      const seeded = this.combatStore.seedTunedParamsFrom(seedPath);
      if (seeded.length) {
        console.log(`[combat-learn] seeded tuned params from simulator: ${seeded.join(', ')}`);
      }
    }
    this.combatOptimizer = new CombatOptimizer(this.combatStore, {
      enabled: learning.enabled,
      exploreRate: learning.explore_rate,
      minTrials: learning.min_trials,
      minHealthToExplore: learning.min_health_to_explore,
      exploreDamageAbort: learning.explore_damage_abort
    });
    (bot as any).on?.('health', () => this.onHealthChanged());
    (bot as any).on?.('attackedTarget', (target: any) => {
      this.episodeTracker.recordHit();
      this.traceOutcome('attack_attempt', target ?? this.currentTarget, {
        result: 'attack_event_only'
      });
    });
    (bot as any).on?.('entityHurt', (target: any) => {
      if (!this.shouldTraceCombatEntity(target)) return;
      this.traceOutcome('target_hurt_observed', target, {
        attribution: 'unconfirmed'
      });
    });
    (bot as any).on?.('entityGone', (entity: any) => {
      if (this.shouldTraceCombatEntity(entity)) {
        const episode = this.episodeTracker.current;
        const countedAsKill = !!episode && (
          (episode.enemyId != null && entity?.id === episode.enemyId)
          || episode.peakEnemyCount >= 2
        );
        this.traceOutcome('target_gone_observed', entity, {
          countedAsKill
        });
      }
      this.onEntityGone(entity);
    });
    (bot as any).on?.('death', () => {
      this.episodeTracker.markDied();
      this.traceOutcome('bot_death', this.currentTarget);
      this.finishEpisode();
    });
  }

  /** 学習状態を永続化する（終了時に呼ぶ）。 */
  flushLearning(): void {
    this.finishEpisode();
    this.combatOptimizer.flush();
  }

  /** 現在の護衛モード（follow / guard）。 */
  get escortMode(): EscortMode {
    return this.mode;
  }

  /**
   * 戦闘が回収・死亡地点帰還・墓処理より優先される場合に true。
   * Guardへ入る前でも割り込みを中断できるよう、直近の被弾も含める。
   */
  get wantsCombat(): boolean {
    return this.ownsTacticalControl || Date.now() < this.recentDamageUntil;
  }

  async tick(opts: {
    movementHeld: boolean;
    isIdleish: boolean;
    owner?: DefendOwner;
    movement?: CombatMovement;
    /** trueなら松明・待機作業だけを省略し、防衛は必ず実行する。 */
    nonCombatHeld?: boolean;
    /** 未武装で自分の墓が近い場合、装備回収のため戦闘を一時停止する。 */
    preferGearRecovery?: boolean;
    /** 相棒Capability間で共有する上位の死亡復旧コンテキスト。 */
    recovery?: RecoveryContext;
    /** 武装済みRecovery中に周囲の脅威へ通常戦闘で応答する。 */
    recoveryDeferCombat?: boolean;
    /** ownerThreatTracker が記録したオーナー被弾情報。 */
    ownerThreat?: OwnerThreatHint;
  }): Promise<void> {
    this.lastOwnerThreat = opts.ownerThreat ?? null;
    if (this.lastOwnerThreat?.attackerId) {
      const age = Date.now() - this.lastOwnerThreat.seenAt;
      if (age < OWNER_THREAT_FRESH_MS) {
        this.recentDamageUntil = Math.max(
          this.recentDamageUntil,
          Date.now() + RECENT_DAMAGE_GRACE_MS
        );
      }
    }
    if (this.config.self_preservation) {
      this.keepAfloat();
    }
    if (!opts.recovery?.active) {
      if (this.recoveryOwned) {
        this.combatTrace.event('recovery_release', {
          mode: this.mode,
          nextOwner: 'combat-or-upper-mode'
        });
      }
      this.recoveryOwned = false;
      if (this.recoveryEmergencyWasActive) {
        this.clearMovementControls();
        this.keepShieldDown();
        this.recoveryEmergencyWasActive = false;
      }
    }
    if (opts.recovery?.active && !opts.recoveryDeferCombat) {
      this.handleRecoverySurvival(opts.recovery, opts.movement);
    } else {
      if (opts.recovery?.active && opts.recoveryDeferCombat && this.recoveryOwned) {
        this.recoveryOwned = false;
        this.recoveryEmergencyWasActive = false;
        this.clearMovementControls();
        this.keepShieldDown();
      }
      if (opts.preferGearRecovery) {
        this.resetCombat();
      } else if (this.config.self_defense && (!opts.movementHeld || this.currentTarget != null)) {
        await this.defend(opts.owner, opts.movement);
      } else if (!this.config.self_defense) {
        this.resetCombat();
      }
    }
    if (
      this.config.torch_placing
      && opts.isIdleish
      && !opts.movementHeld
      && !opts.nonCombatHeld
      && !opts.preferGearRecovery
      && !opts.recoveryDeferCombat
      && !opts.recovery?.active
      && !this.isControllingMovement
    ) {
      await this.maybeTorch();
    }
  }

  /**
   * Recoveryが移動と視線を所有する。上限とcooldown付きの生存行動だけ
   * 割り込みを許し、対象ラッチや追跡は開始しない。
   */
  private handleRecoverySurvival(recovery: RecoveryContext, movement?: CombatMovement): void {
    const now = Date.now();
    if (!this.recoveryOwned) {
      this.resetCombat();
      this.recoveryOwned = true;
    }

    const threats = Object.values(this.bot.entities || {})
      .filter((entity: any) => isHostile(entity) && entity?.position)
      .map((entity: any) => ({
        entity,
        distance: distanceToPos(this.bot.entity.position, entity.position)
      }))
      .filter(({ distance }) => distance <= this.config.hostile_range + TARGET_RANGE_BUFFER)
      .sort((a, b) => a.distance - b.distance);
    const nearest = threats[0];
    const freshDamage = this.lastDamageAt > this.lastRecoveryDamageHandledAt;
    const urgentProximity = Boolean(nearest && nearest.distance <= 2.5);
    const urgentExplosive = Boolean(nearest && this.isIgnitedCreeper(nearest.entity));

    if (
      nearest
      && now >= (recovery.emergencyCooldownUntil || 0)
      && (freshDamage || urgentProximity || urgentExplosive)
    ) {
      this.lastRecoveryDamageHandledAt = Math.max(this.lastRecoveryDamageHandledAt, this.lastDamageAt);
      recovery.emergencyUntil = now + 600;
      recovery.emergencyCooldownUntil = now + 1600;
      movement?.stop?.();
      this.bot.pvp?.forceStop?.();
    }

    if (nearest && now < (recovery.emergencyUntil || 0)) {
      this.recoveryEmergencyWasActive = true;
      const bearing = threatBearingRad(this.bot.entity.position, nearest.entity.position);
      if (isRangedEntity(nearest.entity)) {
        this.applyPerpendicularDodge(bearing, now);
      } else {
        this.applyBearingMovement(bearing + Math.PI);
      }
      if (this.hasShieldEquipped()) this.keepShieldUp();
      this.traceRecovery(recovery, threats, 'survival', now);
      return;
    }

    if (!nearest && now < (recovery.emergencyUntil || 0)) {
      recovery.emergencyUntil = now;
    }
    if (this.recoveryEmergencyWasActive) {
      this.keepShieldDown();
      this.clearMovementControls();
      this.recoveryEmergencyWasActive = false;
    }
    this.traceRecovery(recovery, threats, 'recovery', now);
  }

  private traceRecovery(
    recovery: RecoveryContext,
    threats: Array<{ entity: any; distance: number }>,
    owner: 'recovery' | 'survival',
    now: number
  ): void {
    if (!this.combatTrace.enabled || !this.bot.entity) return;
    const ownedIds = recovery.ownedItemIds || [];
    const remainingIds = ownedIds.filter((id) => Boolean((this.bot.entities as any)?.[id]));
    const pathfinderGoal = (this.bot as any).pathfinder?.goal;
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint']
      .filter((name) => Boolean((this.bot as any).getControlState?.(name)));
    const stateKey = JSON.stringify({
      owner,
      phase: recovery.phase ?? null,
      frozen: recovery.ownedItemIdsFrozen ?? false,
      owned: ownedIds.length,
      remaining: remainingIds.length,
      emergency: now < (recovery.emergencyUntil || 0),
      target: (this.bot as any).pvp?.target?.id ?? null,
      goal: pathfinderGoal?.constructor?.name ?? null,
      controls
    });
    this.combatTrace.recovery(stateKey, {
      owner,
      mode: this.mode,
      phase: recovery.phase ?? null,
      bot: {
        position: this.tracePosition(this.bot.entity.position),
        health: traceNumber(this.bot.health)
      },
      threats: threats.map(({ entity, distance }) => ({
        id: entity?.id ?? null,
        name: entity?.name ?? null,
        distance: traceNumber(distance)
      })),
      collection: {
        captureRemainingMs: Math.max(0, (recovery.collectionCaptureUntil || 0) - now),
        deadlineRemainingMs: Math.max(0, (recovery.collectionDeadlineAt || 0) - now),
        frozen: recovery.ownedItemIdsFrozen ?? false,
        ownedCount: ownedIds.length,
        remainingCount: remainingIds.length
      },
      emergencyRemainingMs: Math.max(0, (recovery.emergencyUntil || 0) - now),
      pvpTargetId: (this.bot as any).pvp?.target?.id ?? null,
      pathfinderGoal: pathfinderGoal?.constructor?.name ?? null,
      controls
    }, now);
  }

  get ownsTacticalControl(): boolean {
    return this.mode === 'guard'
      || combatOwnsControl(Date.now(), this.combatControlUntil);
  }

  get isControllingMovement(): boolean {
    return this.ownsTacticalControl;
  }

  /** より優先度の高い割り込みが所有権を得たら、戦闘ラッチ状態を解除する。 */
  resetCombat(): void {
    this.episodeTracker.markInterrupted();
    this.finishEpisode();
    this.mode = 'follow';
    this.bot.pvp?.forceStop?.();
    this.currentTarget = null;
    this.lastTargetSeenAt = 0;
    this.focusUntil = 0;
    this.activeContextKey = '';
    this.clearCombatMemory();
    this.combatControlUntil = 0;
    this.lastCombatLookAt = 0;
  }

  private clearCombatMemory(): void {
    this.combatMemory = {};
    this.step = null;
    this.lastMovePos = null;
    this.combatGoalIssued = false;
  }

  private protectRanges(): ProtectRanges {
    return {
      ...DEFAULT_PROTECT_RANGES,
      botChaseRange: this.config.hostile_range
    };
  }

  private keepAfloat(): void {
    const bot = this.bot;
    if (!bot.entity) return;
    const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };

    if (blockAbove.name === 'water' && !bot.pathfinder?.goal) {
      // 耕地の上で浮上ジャンプすると畑が土へ戻るため、ここでも例外にしない。
      // 泳ぎ出しは諦め、通常の移動・経路探索へ制御を戻す。
      if (jumpBlockedByFarmland(bot, bot.entity.position, null)) {
        bot.setControlState('jump', false);
        return;
      }
      bot.setControlState('jump', true);
      return;
    }
  }

  private async defend(owner?: DefendOwner, movement?: CombatMovement): Promise<void> {
    const now = Date.now();
    this.lastDefendOwner = owner ?? null;
    this.refreshProtectTarget(owner, now);
    this.transitionMode(owner, movement, now);

    if (this.mode === 'follow') {
      // 1tickだけ対象が消えても上位Follow/Waitや受け渡しに制御を戻さない。
      // 次の防衛tickで再取得を続ける。
      if (this.ownsTacticalControl) return;
      this.finishEpisode();
      this.stopCombat();
      return;
    }

    if (!this.currentTarget) {
      this.finishEpisode();
      this.stopCombat();
      this.mode = 'follow';
      return;
    }

    this.combatMovement = movement;
    await runTree(this.combatTree, null);
  }

  /**
   * 判断（CombatStep）の結果を、優先順に1つ実行する。
   * 条件はこのtickの判断を読むだけで、判断そのものは共通関数にある。
   */
  private buildCombatTree() {
    const step = () => this.step!;
    return sequence('戦闘', [
      action('敵と状況を見て判断する（CombatStep）', () => this.decideStep()),
      selector('判断した行動', [
        sequence('着火したクリーパーから離れる', [
          condition('殴って止められない着火・めり込み', () => step().directFlee),
          action('まっすぐ離れる', () => this.moveTowardStep())
        ]),
        sequence('危険な攻撃範囲から抜ける', [
          condition('囲まれ・射線に晒されている', () => step().movement === 'positioning'),
          action('位置を取り直す', () => this.moveTowardStep()),
          action('届く敵がいれば殴る', () => this.strikeStepTarget())
        ]),
        sequence('遠距離攻撃を避ける', [
          condition('回避の番', () => step().movement === 'dodge'),
          action('横・陰へ動く', () => this.moveTowardStep())
        ]),
        sequence('殴る', [
          condition('届く敵がいる', () => step().movement === 'attack'),
          action('攻撃する', () => this.strikeStepTarget()),
          action('めり込んでいれば少し離れる', () => this.moveTowardStep())
        ]),
        sequence('近づく', [
          condition('届かない', () => step().movement === 'advance'),
          action('接近点へ詰める', () => this.moveTowardStep())
        ]),
        action('その場で構える', () => this.holdPosition())
      ])
    ]);
  }

  /** 観測を集めて共通判断を呼ぶ。主対象がいなければ false。 */
  private decideStep(): boolean {
    const enemy = this.currentTarget;
    if (!enemy || !this.bot.entity) return false;
    const now = Date.now();
    this.syncCombatLearning(enemy, now);
    this.trackMoveProgress();

    const observations = this.collectTacticalObservations(enemy);
    const ownerPos = this.lastDefendOwner?.position ?? null;
    const scene = buildLiveCombatScene({
      bot: this.bot,
      now,
      tick: ++this.combatTick,
      tickMs: COMBAT_TICK_MS,
      threats: observations.map(({ entity }) => entity),
      owner: ownerPos ? { x: ownerPos.x, z: ownerPos.z } : null,
      hasShield: this.hasShieldEquipped(),
      lastDamageAt: this.lastDamageAt,
      priorityThreatId: this.ownerThreatLocked ? enemy.id ?? null : null,
      params: this.activePresetParams
    });
    const step = decideCombatStep(scene, this.combatMemory);
    this.step = step;
    if (!step.primary) return false;

    const lookAt = this.entityById(step.strikeTarget?.id) ?? this.entityById(step.primary.id);
    if (lookAt) this.maintainCombatLook(lookAt, now);
    this.combatMovement?.setSprintAllowed?.(step.movement !== 'attack' && step.movement !== 'stay');
    // 盾: 殴るtickは下げる。遠距離圧で構える意図があれば構える。
    if (!step.strikeTarget && step.intent?.guard && scene.hasShield) this.raiseShield();
    else this.lowerShield();
    this.traceStep(scene, observations, step, now);
    return true;
  }

  /** 判断の移動先へ動く。移動先がなければその場で構える。 */
  private moveTowardStep(): boolean {
    const destination = this.step?.destination;
    if (!destination || !this.bot.entity) return this.holdPosition();
    const pos = this.bot.entity.position;
    this.lastMovePos = { x: pos.x, z: pos.z };
    if (this.combatMovement) {
      this.combatMovement.goToward({ x: destination.x, y: pos.y, z: destination.z }, COMBAT_GOAL_RANGE);
      this.combatGoalIssued = true;
    } else {
      this.applyBearingMovement(threatBearingRad(pos, destination), { sprint: true });
    }
    return true;
  }

  /** 戦闘が出した移動を止める。 */
  private holdPosition(): boolean {
    if (this.combatGoalIssued) {
      this.combatMovement?.stop?.();
      this.combatGoalIssued = false;
    }
    if (!this.combatMovement) this.clearMovementControls();
    return true;
  }

  /** 判断が選んだ敵を、攻撃間隔を守って殴る。 */
  private strikeStepTarget(): boolean {
    const target = this.entityById(this.step?.strikeTarget?.id);
    if (!target) return true;
    const now = Date.now();
    const gap = target.name === 'creeper' ? CREEPER_STRIKE_GAP_MS : MELEE_STRIKE_GAP_MS;
    if (now - this.lastStrikeAt < gap) return true;
    this.lastStrikeAt = now;
    this.lowerShield();
    try {
      const look = target.position.offset?.(0, (target.height ?? 1.8) * 0.9, 0) || target.position;
      void Promise.resolve(this.bot.lookAt?.(look, true)).catch(() => {});
      this.bot.attack?.(target);
    } catch {
      /* 失敗は無視する */
    }
    return true;
  }

  /**
   * 前tickの移動がほとんど進まなければ詰まりとして数え、回り込む向きを変える
   * （箱庭の approachStuckTicks と同じ）。
   */
  private trackMoveProgress(): void {
    const last = this.lastMovePos;
    this.lastMovePos = null;
    if (!last || !this.bot.entity) return;
    const pos = this.bot.entity.position;
    const memory = this.combatMemory;
    if (Math.hypot(pos.x - last.x, pos.z - last.z) < STUCK_PROGRESS) {
      memory.approachStuckTicks = (memory.approachStuckTicks || 0) + 1;
      memory.approachFlankSign = memory.approachFlankSign === 1 ? -1 : 1;
    } else {
      memory.approachStuckTicks = 0;
    }
  }

  private entityById(id: number | null | undefined): any | null {
    if (id == null) return null;
    return (this.bot.entities as any)?.[id] ?? null;
  }

  /** MovementControllerがない場合の移動キーフォールバック。 */
  private applyBearingMovement(bearingRad: number, opts: { sprint?: boolean } = {}): void {
    if (!this.bot.entity) return;
    const controls = movementControlsTowardBearing(bearingRad, this.bot.entity.yaw);
    this.bot.setControlState('forward', controls.forward);
    this.bot.setControlState('back', controls.back);
    this.bot.setControlState('left', controls.left);
    this.bot.setControlState('right', controls.right);
    this.bot.setControlState('sprint', Boolean(opts.sprint));
    applyCombatStepAssist(this.bot, bearingRad);
  }

  /** 入射・共通脅威方向と直交するワールド座標方向へ回避する。 */
  private applyPerpendicularDodge(threatBearing: number, now: number): number {
    if (now >= this.strafeUntil) {
      this.strafeSign = this.strafeSign === 1 ? -1 : 1;
      this.strafeUntil = now + STRAFE_SWITCH_MS;
    }
    const bearing = perpendicularDodgeBearing(threatBearing, this.strafeSign);
    this.applyBearingMovement(bearing);
    return bearing;
  }

  private clearMovementControls(): void {
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
  }

  /** 毎tick視線命令を出さず、主脅威への戦闘視線を維持する。 */
  private maintainCombatLook(enemy: any, now: number): void {
    if (!enemy?.position || now - this.lastCombatLookAt < 250) return;
    this.lastCombatLookAt = now;
    const look = enemy.position.offset?.(
      0,
      Math.max(0.8, (enemy.height ?? 1.8) * 0.9),
      0
    ) || enemy.position;
    void Promise.resolve(this.bot.lookAt?.(look, true)).catch(() => {});
  }

  private traceStep(
    scene: CombatScene,
    observations: TacticalThreatObservation[],
    step: CombatStep,
    now: number
  ): void {
    if (!this.combatTrace.enabled || !this.bot.entity || !step.intent) return;
    const botPos = this.bot.entity.position;
    const ownerPos = this.lastDefendOwner?.position ?? null;
    const threats = observations
      .map(({ entity, source }) => {
        const traced = this.traceEntity(entity);
        return traced ? {
          ...traced,
          source,
          enemyClass: classifyEnemy(entity?.name),
          ranged: isRangedEntity(entity)
        } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const selection = step.detail?.selection ?? null;
    const arc = step.detail?.arc ?? null;
    const primary = this.entityById(step.primary?.id);
    const previous = this.lastTracePosition;
    const displacement = previous
      ? Math.hypot(botPos.x - previous.x, botPos.z - previous.z)
      : 0;
    const actualBearingRad = previous && displacement >= 0.05
      ? threatBearingRad(previous, botPos)
      : null;
    const destination = step.destination;
    const stateKey = JSON.stringify({
      mode: this.mode,
      primary: primary?.id ?? null,
      threats: threats.map((threat) => threat.id ?? threat.name),
      owner: ownerPos ? this.tracePosition(ownerPos) : null,
      latch: Boolean(this.combatMemory.arcNarrowLatched),
      moved: selection?.moved ?? false,
      intent: step.intent.priority,
      movement: step.movement,
      dodge: step.dodgePhase
    });

    const emitted = this.combatTrace.decision(stateKey, {
      mode: this.mode,
      preset: this.activePresetId,
      bot: {
        position: this.tracePosition(botPos),
        yawDeg: traceDegrees(this.bot.entity.yaw),
        health: traceNumber(this.bot.health)
      },
      owner: ownerPos ? this.tracePosition(ownerPos) : null,
      primary: this.traceEntity(primary),
      threats,
      arc: arc ? {
        spanDeg: traceDegrees(arc.spanRad, false),
        midBearingDeg: traceDegrees(arc.midRad),
        latched: Boolean(this.combatMemory.arcNarrowLatched),
        threatCount: scene.threats.length,
        tacticalRadius: this.tacticalObservationRadius(),
        rangedThreatCount: step.rangedPressure
      } : null,
      candidate: selection ? {
        moved: selection.moved,
        improvement: traceNumber(selection.improvement, 3),
        chosen: this.tracePosition(selection.chosen.position)
      } : null,
      plan: step.mixedPlan?.phase ?? null,
      destination: destination ? this.tracePosition(destination) : null,
      strikeTargetId: step.strikeTarget?.id ?? null,
      intent: step.intent,
      dodge: { phase: step.dodgePhase },
      movement: {
        kind: step.movement,
        commandedBearingDeg: destination ? traceDegrees(threatBearingRad(botPos, destination)) : null,
        actualBearingDeg: actualBearingRad == null
          ? null
          : traceDegrees(actualBearingRad),
        displacement: traceNumber(displacement, 3)
      }
    }, now);
    if (emitted) {
      this.lastTracePosition = { x: botPos.x, z: botPos.z, at: now };
    }
  }

  private tracePosition(position: { x: number; y?: number; z: number }): object {
    return {
      x: traceNumber(position.x),
      ...(Number.isFinite(position.y) ? { y: traceNumber(position.y as number) } : {}),
      z: traceNumber(position.z)
    };
  }

  private traceEntity(entity: any): TraceEntity | null {
    if (!entity?.position || !this.bot.entity) return null;
    const botPos = this.bot.entity.position;
    return {
      id: entity.id ?? null,
      name: entity.name ?? null,
      position: this.tracePosition(entity.position),
      distance: traceNumber(distanceToPos(botPos, entity.position)),
      bearingDeg: traceDegrees(threatBearingRad(botPos, entity.position))
    };
  }

  private traceOutcome(
    event: string,
    target: any,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.combatTrace.enabled) return;
    this.combatTrace.event(event, {
      mode: this.mode,
      preset: this.activePresetId,
      bot: this.bot.entity ? {
        position: this.tracePosition(this.bot.entity.position),
        health: traceNumber(this.bot.health)
      } : null,
      target: this.traceEntity(target),
      ...extra
    });
  }

  private shouldTraceCombatEntity(entity: any): boolean {
    if (!this.combatTrace.enabled || !entity) return false;
    if (entity?.id != null && entity.id === this.currentTarget?.id) return true;
    if (!this.bot.entity) return false;
    return isProtectThreat(
      this.bot.entity.position,
      this.lastDefendOwner?.position ?? null,
      entity,
      this.protectRanges()
    ) != null;
  }

  /**
   * 視野角を使わないprotect方針で護衛対象を維持・取得する。
   * 新規固定にはBot→敵の視線が必要で、固定済み対象には短い見失い猶予を与える。
   */
  private refreshProtectTarget(owner: DefendOwner, now: number): void {
    const ranges = this.protectRanges();
    const ownerPos = owner?.position;
    const botPos = this.bot.entity?.position;
    if (!botPos) {
      this.currentTarget = null;
      return;
    }

    if (!this.currentTarget && this.bot.pvp?.target) {
      const livePvp = this.resolveLiveTarget(this.bot.pvp.target);
      if (
        this.isUsableTarget(livePvp)
        && isProtectThreat(botPos, ownerPos, livePvp, ranges)
        && hasLineOfSight(this.bot, livePvp)
      ) {
        this.currentTarget = livePvp;
        this.lastTargetSeenAt = now;
      }
    }

    if (this.currentTarget) {
      this.currentTarget = this.resolveLiveTarget(this.currentTarget);
      if (!this.isUsableTarget(this.currentTarget)) {
        this.currentTarget = null;
      } else {
        const reason = isProtectThreat(botPos, ownerPos, this.currentTarget, ranges);
        const ownerBotDist = ownerPos ? distanceToPos(ownerPos, botPos) : 0;
        const ownerEnemyDist = ownerPos && this.currentTarget.position
          ? distanceToPos(ownerPos, this.currentTarget.position)
          : 0;
        // 護衛leash: Bot直近の脅威だけでownerから無期限に引き離されないようにする。
        // Botと敵の両方がowner範囲外なら更新を止め、見失い猶予後に追跡を解除する。
        const leashBroken = !!(
          reason === 'self-immediate'
          && ownerPos
          && ownerBotDist > ranges.ownerProtectRange
          && ownerEnemyDist > ranges.ownerProtectRange
        );
        if (reason && !leashBroken) {
          if (hasLineOfSight(this.bot, this.currentTarget)) {
            this.lastTargetSeenAt = now;
          } else if (now - this.lastTargetSeenAt > this.config.combat_lost_grace_ms) {
            this.currentTarget = null;
          }
        } else if (now - this.lastTargetSeenAt > this.config.combat_lost_grace_ms) {
          this.currentTarget = null;
        }
      }
    }

    const stickyTarget = this.currentTarget;
    const canSwitch = !stickyTarget || now >= this.focusUntil;
    const hasLos = (entity: any) => hasLineOfSight(this.bot, entity);
    const ownerThreatLocked = this.applyOwnerThreatPriority(
      ownerPos,
      botPos,
      ranges,
      hasLos,
      now
    );
    this.ownerThreatLocked = ownerThreatLocked;

    if (!this.currentTarget) {
      let picked = pickProtectTarget(this.bot, ownerPos, ranges, hasLos, this.lastOwnerThreat);
      // 被弾は強制的な自己防衛トリガーとし、owner範囲外でも短時間は
      // recentDamageUntilにより最寄りの敵と戦う。
      if (!picked && now < this.recentDamageUntil) {
        picked = pickProtectTarget(
          this.bot,
          null,
          { ...ranges, ownerProtectRange: 0, selfImmediateRange: ranges.botChaseRange },
          hasLos,
          this.lastOwnerThreat
        );
        if (!picked) {
          picked = pickProtectTarget(this.bot, null, {
            ...ranges,
            ownerProtectRange: 0,
            selfImmediateRange: ranges.botChaseRange
          }, () => true, this.lastOwnerThreat);
        }
      }
      if (picked) {
        this.currentTarget = picked;
        this.syncCombatLearning(picked, now);
        this.lastTargetSeenAt = now;
        this.focusUntil = now + FOCUS_STICKY_MS;
      }
    } else if (canSwitch && stickyTarget && !ownerThreatLocked) {
      // 同ティア内のちらつきだけ CombatFocus で抑制
      const preferred = pickProtectTarget(
        this.bot,
        ownerPos,
        ranges,
        hasLos,
        this.lastOwnerThreat
      );
      if (preferred && preferred.id !== stickyTarget.id) {
        const preferredReason = isProtectThreat(botPos, ownerPos, preferred, ranges);
        const stickyReason = isProtectThreat(botPos, ownerPos, stickyTarget, ranges);
        // 優先度（オーナー近傍か自分の直近か）が違うときだけ護衛対象を替える。
        // 同じ優先度の中でどれを殴るかは共通判断の主対象選び（CombatStep）が決める。
        if (preferredReason !== stickyReason) {
          this.currentTarget = preferred;
          this.syncCombatLearning(preferred, now);
          this.lastTargetSeenAt = now;
          this.focusUntil = now + FOCUS_STICKY_MS;
        }
      } else if (stickyTarget) {
        this.focusUntil = now + FOCUS_STICKY_MS;
      }
    }
  }

  /**
   * オーナー被弾の襲撃者を最優先で currentTarget に固定する。
   * @returns true when locked onto the owner-attacker this tick
   */
  private applyOwnerThreatPriority(
    ownerPos: DefendOwnerEntity['position'] | null | undefined,
    botPos: { x: number; y: number; z: number },
    ranges: ProtectRanges,
    hasLos: (entity: any) => boolean,
    now: number
  ): boolean {
    const ownerThreatId = this.lastOwnerThreat?.attackerId ?? null;
    if (ownerThreatId == null) return false;

    const ownerAttacker = this.resolveLiveTarget(this.bot.entities?.[ownerThreatId]);
    if (!ownerAttacker || !this.isUsableTarget(ownerAttacker)) return false;

    if (this.currentTarget?.id === ownerAttacker.id) {
      if (hasLos(ownerAttacker)) this.lastTargetSeenAt = now;
      return true;
    }

    if (!hasLos(ownerAttacker)) return false;
    if (isProtectThreat(botPos, ownerPos, ownerAttacker, ranges) == null) return false;

    if (this.currentTarget?.id !== ownerAttacker.id) {
      this.currentTarget = ownerAttacker;
      this.syncCombatLearning(ownerAttacker, now);
      this.lastTargetSeenAt = now;
      this.focusUntil = now + FOCUS_STICKY_MS;
    }
    return true;
  }

  private transitionMode(
    _owner: DefendOwner,
    movement: CombatMovement | undefined,
    now: number
  ): void {
    const hasThreat = this.currentTarget != null;
    const previousMode = this.mode;

    // HP基準のRetreatでは、Botが敵へ背を向けownerへ走り、射撃下で停止した
    // （実行ログで確認済み）。護衛は低HPでも脅威が消えるまでGuardで戦う。
    this.mode = hasThreat ? 'guard' : 'follow';
    this.combatControlUntil = refreshCombatControlUntil({
      now,
      previousUntil: this.combatControlUntil,
      activeThreat: hasThreat
    });
    if (hasThreat && previousMode === 'follow') {
      // 上位モードの選択は維持するが、pvp・位置取りが戦術目的地を設定する前に
      // owner目的地を解除する。
      movement?.stop?.();
    }
  }

  private stopCombat(): void {
    if (this.fighting) return;
    this.clearCombatMemory();
    this.lowerShield();
    this.combatControlUntil = 0;
    this.lastCombatLookAt = 0;
    this.fighting = true;
    void Promise.resolve(this.bot.pvp?.stop?.()).catch(() => {}).finally(() => {
      this.fighting = false;
      this.currentTarget = null;
      this.lastTargetSeenAt = 0;
    });
  }

  private resolveLiveTarget(target: any): any | null {
    if (!target) return null;
    if (target.id == null || !this.bot.entities) return target;
    return this.bot.entities[target.id] || null;
  }

  private isUsableTarget(target: any): boolean {
    if (!target || !isHostile(target) || !target.position || target.isValid === false) {
      return false;
    }
    return this.bot.entity.position.distanceTo(target.position)
      <= this.config.hostile_range + TARGET_RANGE_BUFFER;
  }

  private keepShieldDown(): void {
    try {
      this.bot.deactivateItem();
    } catch {
      /* 失敗は無視する */
    }
  }

  private keepShieldUp(): void {
    try {
      this.bot.activateItem?.(true);
    } catch {
      /* 失敗は無視する */
    }
  }

  private raiseShield(): void {
    if (this.shieldRaised) return;
    this.shieldRaised = true;
    this.keepShieldUp();
  }

  private lowerShield(): void {
    if (!this.shieldRaised) return;
    this.shieldRaised = false;
    this.keepShieldDown();
  }

  private isIgnitedCreeper(enemy: any): boolean {
    return isCreeperIgnited(enemy);
  }

  private collectTacticalObservations(primary: any): TacticalThreatObservation[] {
    if (!this.bot.entity) return [];
    return collectTacticalThreatObservations({
      botPos: this.bot.entity.position,
      primary,
      entities: Object.values(this.bot.entities || {}),
      radius: this.tacticalObservationRadius(),
      hasLineOfSight: (entity) => hasLineOfSight(this.bot, entity)
    });
  }

  private tacticalObservationRadius(): number {
    return Math.min(
      DEFAULT_TACTICAL_OBSERVATION_RADIUS,
      Math.max(0, this.config.hostile_range)
    );
  }

  private hasShieldEquipped(): boolean {
    try {
      const pvp = this.bot.pvp as any;
      if (typeof pvp?.hasShield === 'function') return !!pvp.hasShield();
      const slot = this.bot.inventory.slots[this.bot.getEquipmentDestSlot('off-hand')];
      return !!slot?.name?.includes('shield');
    } catch {
      return false;
    }
  }

  private buildCombatContext(enemy: any): CombatContext {
    return {
      enemyClass: classifyEnemy(enemy?.name),
      hasShield: this.hasShieldEquipped()
    };
  }

  private syncCombatLearning(enemy: any, now: number): void {
    if (!enemy) return;
    const enemyCount = Math.max(
      1,
      countNearbyHostiles(
        this.bot.entities,
        this.bot.entity.position,
        this.config.hostile_range + TARGET_RANGE_BUFFER,
        isHostile
      )
    );
    const context = this.buildCombatContext(enemy);

    if (!this.combatOptimizer.enabled) {
      this.activePresetId = baselinePresetId(context);
      this.activePresetParams = getPresetParams(this.activePresetId);
      return;
    }

    const key = `${context.enemyClass}|${context.hasShield ? 1 : 0}`;
    this.episodeTracker.noteEnemyCount(enemyCount);

    if (key !== this.activeContextKey || !this.episodeTracker.current) {
      if (this.episodeTracker.current) this.finishEpisode();
      const choice = this.combatOptimizer.pickPreset({
        context,
        health: this.bot.health,
        now
      });
      this.activeContextKey = key;
      this.activePresetId = choice.presetId;
      this.activePresetParams = choice.params;
      this.episodeTracker.begin({
        context,
        presetId: choice.presetId,
        exploring: choice.exploring,
        exploringParams: choice.exploringParams,
        paramOverlay: choice.paramOverlay,
        enemyName: enemy.name ?? null,
        enemyId: enemy.id ?? null,
        enemyCount,
        now
      });
      console.log(
        `[combat-learn] pick ${choice.reason} preset=${choice.presetId} `
        + `class=${context.enemyClass} shield=${context.hasShield}`
      );
    }
  }

  private finishEpisode(): void {
    const episode = this.episodeTracker.end();
    if (!episode) return;
    this.combatTrace.event('episode_end', {
      preset: episode.presetId,
      enemyName: episode.enemyName,
      startEnemyCount: episode.startEnemyCount,
      peakEnemyCount: episode.peakEnemyCount,
      durationMs: Math.max(0, (episode.endedAt ?? Date.now()) - episode.startedAt),
      damageTaken: traceNumber(episode.damageTaken),
      attackEvents: episode.hitsLanded,
      observedGoneCount: episode.kills,
      retreated: episode.retreated,
      died: episode.died,
      interrupted: episode.interrupted,
      learnable: episode.learnable
    });
    this.combatOptimizer.completeEpisode(episode);
    this.activeContextKey = '';
  }

  private onEntityGone(entity: any): void {
    if (!entity || !isHostile(entity)) return;
    const current = this.episodeTracker.current;
    if (!current) return;
    if (current.enemyId != null && entity.id === current.enemyId) {
      this.episodeTracker.recordKill();
      this.finishEpisode();
      return;
    }
    if ((current.peakEnemyCount || 0) >= 2) {
      this.episodeTracker.recordKill();
    }
  }

  private onHealthChanged(): void {
    const health = this.bot.health;
    const previousHealth = this.lastHealth;
    const damage = previousHealth - health;
    this.lastHealth = health;
    if (health !== previousHealth) {
      this.traceOutcome('health_delta', this.currentTarget, {
        previousHealth: traceNumber(previousHealth),
        health: traceNumber(health),
        delta: traceNumber(health - previousHealth),
        damageTaken: traceNumber(Math.max(0, damage))
      });
    }
    if (damage > 0) {
      this.episodeTracker.recordDamage(damage);
      // 攻撃を受けたら戦闘へ入り、護衛の基本的な自己防衛を続ける。
      const now = Date.now();
      this.lastDamageAt = now;
      this.recentDamageUntil = now + RECENT_DAMAGE_GRACE_MS;
      this.combatControlUntil = refreshCombatControlUntil({
        now,
        previousUntil: this.combatControlUntil,
        activeThreat: false,
        freshDamage: true
      });
    }
  }

  private async maybeTorch(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTorchAt < TORCH_PLACE_COOLDOWN_MS) return;

    const pos = this.bot.entity?.position;
    if (!pos) return;

    const torch = this.bot.inventory.items().find((i) => isTorchItemName(i.name));
    if (!torch) return;

    const feet = this.bot.blockAt(pos);
    if (!feet || feet.name !== 'air') return;

    const below = this.bot.blockAt(pos.offset(0, -1, 0));
    if (!below || !below.name || below.name === 'air' || below.name === 'water') return;

    const timeOfDay = this.bot.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
    const brightness = estimateBrightness({
      skyLight: (feet as LightSample).skyLight ?? null,
      isNight,
      torchDistance: nearestTorchDistance(
        (x, y, z) => this.bot.blockAt(new Vec3(x, y, z)),
        pos,
        torchScanRadius(this.torchLightThreshold)
      )
    });
    if (brightness > this.torchLightThreshold) return;

    this.lastTorchAt = now;
    try {
      await this.bot.equip(torch, 'hand');
      await this.bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
      /* placement often fails in motion; ignore */
    }
  }
}

function distanceToPos(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const withDistance = a as { distanceTo?: (other: any) => number };
  if (typeof withDistance.distanceTo === 'function') return withDistance.distanceTo(b);
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function traceNumber(value: number, digits = 2): number | null {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function traceDegrees(radians: number, normalize = true): number | null {
  if (!Number.isFinite(radians)) return null;
  let degrees = (radians * 180) / Math.PI;
  if (normalize) {
    while (degrees > 180) degrees -= 360;
    while (degrees <= -180) degrees += 360;
  }
  return traceNumber(degrees, 1);
}
