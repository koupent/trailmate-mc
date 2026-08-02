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
  blendCrowdAvoidDirection,
  classifyEnemy,
  countNearbyHostiles,
  crowdAwayDirection,
  decideSpacing,
  getPresetParams,
  isRangedEntity,
  type CombatContext,
  type CombatPresetParams
} from '../combat/CombatProfiles.js';
import {
  chooseBestThreatPosition,
  computeThreatArc,
  movementControlsTowardBearing,
  perpendicularDodgeBearing,
  strafeSignForOpenArc,
  threatBearingRad,
  TARGET_THREAT_SPAN_RAD,
  WIDE_THREAT_SPAN_RAD,
  shouldEnterArcNarrowing,
  shouldExitArcNarrowing,
} from '../combat/threatArc.js';
import { CombatEpisodeTracker } from '../combat/CombatEpisodeTracker.js';
import {
  decideCombatIntent,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch,
  type RangedDodgeLatch
} from '../combat/CombatIntent.js';
import { CombatOptimizer } from '../combat/CombatOptimizer.js';
import { CombatStateStore } from '../combat/CombatStateStore.js';
import { CombatTrace } from '../combat/CombatTrace.js';
import {
  collectTacticalThreatObservations,
  DEFAULT_TACTICAL_OBSERVATION_RADIUS,
  type TacticalThreatObservation
} from '../combat/TacticalObservation.js';
import {
  applyCombatStepAssist,
  stepAheadAlongBearing
} from '../combat/combatStepAssist.js';
import {
  combatOwnsControl,
  refreshCombatControlUntil
} from '../combat/TacticalOwnership.js';
import {
  estimateBrightness,
  nearestTorchDistance,
  torchScanRadius,
  TORCH_PLACE_COOLDOWN_MS,
  type LightSample
} from './torchPlacement.js';

type DefendOwner = {
  position: {
    x: number;
    y: number;
    z: number;
    offset: (x: number, y: number, z: number) => any;
    distanceTo?: (other: { x: number; y: number; z: number }) => number;
  };
  height?: number;
} | null | undefined;

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
const RETREAT_GOAL_RANGE = 1.5;
const RETREAT_MELEE_RANGE = 3.5;
/** この距離内では実際に攻撃できるよう `back` 入力を解除する。 */
const MELEE_COMMIT_RANGE = 1.8;
const WIDE_REPOSITION_OWNER_ALLOWANCE = 2.25;
const COMBAT_MOVE_DISPLACEMENT_WINDOW_MS = 600;
const COMBAT_STUCK_DISPLACEMENT = 0.03;
const COMBAT_STUCK_FLIP_MS = 350;
const COMBAT_REPOSITION_CLIMB_HOLD_MS = 1200;

type ThreatArcBias = {
  sign: 1 | -1;
  spanRad: number;
  midRad: number;
  destination: { x: number; z: number } | null;
  threatCount: number;
  rangedThreatCount: number;
  observations: TacticalThreatObservation[];
  selection: ReturnType<typeof chooseBestThreatPosition>;
};

type CombatMovementTrace = {
  kind: 'none' | 'positioning' | 'dodge' | 'strafe' | 'advance' | 'retreat';
  bearingRad: number | null;
  destination: { x: number; y?: number; z: number } | null;
  dodgePhase: 'idle' | 'dodge' | 'advance' | 'attack';
  burstRemainingMs: number;
  advanceRemainingMs: number;
};

type CombatIntentDecision = ReturnType<typeof decideCombatIntent>;

type TraceEntity = {
  id: number | string | null;
  name: string | null;
  position: object;
  distance: number | null;
  bearingDeg: number | null;
};

/**
 * 護衛相棒のReflexes。Follow / Guard / Retreatのモード機械。
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
  private focusUntil = 0;
  private readonly episodeTracker = new CombatEpisodeTracker();
  private readonly combatOptimizer: CombatOptimizer;
  private readonly combatStore: CombatStateStore;
  private readonly combatTrace: CombatTrace;
  private lastPassiveStrikeAt = 0;
  /** 位置取り中に空いた円弧へ向かう経路更新を間引く。 */
  private arcRepositionUntil = 0;
  /** spanが終了閾値を下回るまで円弧収束を続けるヒステリシスラッチ。 */
  private arcNarrowLatched = false;
  /** 防衛中に最後に確認したowner（角度leash用）。 */
  private lastDefendOwner: DefendOwner = null;
  /** 被弾後の短時間は自己防衛を強制する。 */
  private recentDamageUntil = 0;
  /** 上限付き遠距離回避→前進サイクル用の小さなヒステリシスラッチ。 */
  private rangedDodgeLatch: RangedDodgeLatch = idleRangedDodgeLatch();
  private lastDamageAt = 0;
  /** 対象が一瞬消えても、戦闘が移動・視線所有権を短時間維持する。 */
  private combatControlUntil = 0;
  private lastCombatLookAt = 0;
  private lastTracePosition: { x: number; z: number; at: number } | null = null;
  /** Recoveryは上位目標であり、戦闘側は短い生存行動だけ割り込める。 */
  private recoveryOwned = false;
  private recoveryEmergencyWasActive = false;
  private lastRecoveryDamageHandledAt = 0;
  private combatMoveLastAt = 0;
  private combatMoveLastPos: { x: number; z: number } | null = null;
  /** 段差に押し付けられて横移動が進まないときの反転判定。 */
  private combatStuckSince = 0;
  /** ownerThreatTracker が記録したオーナー被弾情報。 */
  private lastOwnerThreat: OwnerThreatHint = null;

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
    if (this.config.self_preservation) {
      this.preserve();
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
      } else if (this.config.self_defense && !opts.movementHeld) {
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
    this.arcNarrowLatched = false;
    this.arcRepositionUntil = 0;
    this.rangedDodgeLatch = idleRangedDodgeLatch();
    this.combatControlUntil = 0;
    this.lastCombatLookAt = 0;
  }

  private protectRanges(): ProtectRanges {
    return {
      ...DEFAULT_PROTECT_RANGES,
      botChaseRange: this.config.hostile_range
    };
  }

  private preserve(): void {
    const bot = this.bot;
    if (!bot.entity) return;
    const block = bot.blockAt(bot.entity.position) || { name: 'air' };
    const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0)) || { name: 'air' };

    if (blockAbove.name === 'water' && !bot.pathfinder?.goal) {
      bot.setControlState('jump', true);
      return;
    }

    if (
      block.name === 'lava' || block.name === 'fire'
      || blockAbove.name === 'lava' || blockAbove.name === 'fire'
    ) {
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
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

    // 防御
    const enemy = this.currentTarget;
    if (!enemy) {
      this.finishEpisode();
      this.stopCombat();
      this.mode = 'follow';
      return;
    }

    this.syncCombatLearning(enemy, now);
    this.maintainCombatLook(enemy, now);

    this.configureCombatRange(enemy);
    const arcBias = this.collectThreatArcBias(enemy);

    if (this.shouldNarrowThreatArc(arcBias)) {
      const intent = this.decideCurrentCombatIntent(enemy, arcBias);
      const movementTrace = this.runArcNarrowing(enemy, arcBias!, intent, movement, now);
      this.traceCombatDecision(enemy, arcBias, intent, movementTrace, now);
      return;
    }
    const traceIntent = this.combatTrace.enabled
      ? this.decideCurrentCombatIntent(enemy, arcBias)
      : null;

    if (this.shouldEvadeCreeper(enemy)) {
      this.bot.pvp?.forceStop?.();
      this.applyCombatSpacing(enemy, arcBias);
      this.moveAwayFrom(enemy, movement);
      this.traceCombatDecision(enemy, arcBias, traceIntent, {
        ...this.idleMovementTrace(),
        kind: 'retreat',
        bearingRad: threatBearingRad(this.bot.entity!.position, enemy.position) + Math.PI
      }, now);
      return;
    }

    const movementTrace = this.applyCombatSpacing(enemy, arcBias);
    this.ensureAttackTarget(enemy);
    this.meleeAssistStrike(enemy, now);
    this.traceCombatDecision(enemy, arcBias, traceIntent, movementTrace, now);
  }

  /**
   * 複数脅威の円弧。敵種別行動より先に共通の扇形を改善する。
   * 近接・遠距離・爆発・混成のすべてに適用する。
   */
  private shouldNarrowThreatArc(arcBias: ThreatArcBias | null): boolean {
    if (!arcBias) {
      this.arcNarrowLatched = false;
      return false;
    }
    if (arcBias.threatCount < 2) {
      this.arcNarrowLatched = false;
      return false;
    }
    if (this.arcNarrowLatched) {
      if (shouldExitArcNarrowing(arcBias.spanRad)) {
        this.arcNarrowLatched = false;
      }
    } else if (shouldEnterArcNarrowing({
      threatCount: arcBias.threatCount,
      spanRad: arcBias.spanRad
    })) {
      this.arcNarrowLatched = true;
    }
    return this.arcNarrowLatched;
  }

  private runArcNarrowing(
    enemy: any,
    arcBias: ThreatArcBias,
    intent: CombatIntentDecision,
    movement: CombatMovement | undefined,
    now: number
  ): CombatMovementTrace {
    this.clearMovementControls();
    let movementTrace = this.idleMovementTrace();

    if (arcBias.destination) {
      this.rangedDodgeLatch = idleRangedDodgeLatch();
      // ワールド座標の位置取り目的地を設定する前にpvp経路探索を止める。
      // 位置取り中でもmeleeAssistStrikeによる近距離攻撃は許可する。
      const releasedPvpGoal = this.bot.pvp?.target != null;
      if (releasedPvpGoal) this.bot.pvp?.forceStop?.();
      if (intent.guard) this.keepShieldUp();
      if (movement && (releasedPvpGoal || now >= this.arcRepositionUntil)) {
        const botPos = this.bot.entity?.position;
        const dest = arcBias.destination;
        const bearing = botPos
          ? threatBearingRad(botPos, dest)
          : null;
        const step = bearing != null ? stepAheadAlongBearing(this.bot, bearing) : null;
        if (step && movement.climbTo) {
          movement.climbTo(step.center, COMBAT_REPOSITION_CLIMB_HOLD_MS);
        } else if (botPos) {
          movement.goToward({
            x: dest.x,
            y: step?.center.y ?? botPos.y,
            z: dest.z
          }, 0.75);
        }
        this.arcRepositionUntil = now + 400;
      } else if (!movement && this.bot.entity) {
        this.applyBearingMovement(threatBearingRad(
          this.bot.entity.position,
          arcBias.destination
        ));
      }
      movementTrace = {
        ...movementTrace,
        kind: 'positioning',
        bearingRad: this.bot.entity
          ? threatBearingRad(this.bot.entity.position, arcBias.destination)
          : null,
        destination: {
          x: arcBias.destination.x,
          y: this.bot.entity?.position.y,
          z: arcBias.destination.z
        }
      };
    } else {
      // 扇形が適度に狭まったら戦闘を続け、pathfinderに攻撃目標を奪わせず、
      // 既存の円弧誘導横移動を使う。
      movementTrace = this.applyCombatSpacing(enemy, arcBias);
      this.ensureAttackTarget(enemy);
    }

    if (intent.attack && !intent.guard) this.meleeAssistStrike(enemy, now);
    return movementTrace;
  }

  private decideCurrentCombatIntent(
    enemy: any,
    arcBias: ThreatArcBias | null
  ): CombatIntentDecision {
    return decideCombatIntent({
      distanceToPrimary: enemy?.position && this.bot.entity
        ? distanceToPos(this.bot.entity.position, enemy.position)
        : Infinity,
      meleeAttackRange: RETREAT_MELEE_RANGE,
      rangedThreatCount: arcBias?.rangedThreatCount ?? (isRangedEntity(enemy) ? 1 : 0),
      hasShield: this.hasShieldEquipped(),
      guardRangedThreatThreshold: this.activePresetParams.guardRangedThreatThreshold,
      explosiveImmediateDanger: this.isIgnitedCreeper(enemy)
    });
  }

  /** MovementControllerがない場合の移動キーフォールバック。 */
  private applyBearingMovement(bearingRad: number): void {
    if (!this.bot.entity) return;
    const controls = movementControlsTowardBearing(bearingRad, this.bot.entity.yaw);
    this.bot.setControlState('forward', controls.forward);
    this.bot.setControlState('back', controls.back);
    this.bot.setControlState('left', controls.left);
    this.bot.setControlState('right', controls.right);
    applyCombatStepAssist(this.bot, bearingRad);
  }

  private combatDisplacement(now: number): number {
    if (!this.bot.entity) return 0;
    const pos = this.bot.entity.position;
    let displacement = 0;
    if (this.combatMoveLastPos && now - this.combatMoveLastAt <= COMBAT_MOVE_DISPLACEMENT_WINDOW_MS) {
      displacement = Math.hypot(pos.x - this.combatMoveLastPos.x, pos.z - this.combatMoveLastPos.z);
    }
    this.combatMoveLastPos = { x: pos.x, z: pos.z };
    this.combatMoveLastAt = now;
    return displacement;
  }

  private strafeBearingToward(enemy: any): number {
    return perpendicularDodgeBearing(
      threatBearingRad(this.bot.entity!.position, enemy.position),
      this.strafeSign
    );
  }

  private applyStrafeControls(sign: 1 | -1, bearingRad: number): void {
    this.bot.setControlState(sign === 1 ? 'left' : 'right', true);
    applyCombatStepAssist(this.bot, bearingRad);
  }

  private maybeFlipStuckStrafe(stepAhead: boolean, displacement: number, now: number): void {
    if (!stepAhead || displacement >= COMBAT_STUCK_DISPLACEMENT) {
      this.combatStuckSince = 0;
      return;
    }
    if (!this.combatStuckSince) this.combatStuckSince = now;
    if (now - this.combatStuckSince < COMBAT_STUCK_FLIP_MS) return;
    this.strafeSign = this.strafeSign === 1 ? -1 : 1;
    this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
    this.combatStuckSince = 0;
  }

  /** 入射・共通脅威方向と直交するワールド座標方向へ回避する。 */
  private applyPerpendicularDodge(threatBearing: number, now: number): number {
    if (now >= this.strafeUntil) {
      this.strafeSign = this.strafeSign === 1 ? -1 : 1;
      this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
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

  private idleMovementTrace(): CombatMovementTrace {
    return {
      kind: 'none',
      bearingRad: null,
      destination: null,
      dodgePhase: 'idle',
      burstRemainingMs: 0,
      advanceRemainingMs: 0
    };
  }

  private traceCombatDecision(
    primary: any,
    arcBias: ThreatArcBias | null,
    intent: CombatIntentDecision | null,
    movement: CombatMovementTrace,
    now: number
  ): void {
    if (!this.combatTrace.enabled || !this.bot.entity || !intent) return;
    const botPos = this.bot.entity.position;
    const ownerPos = this.lastDefendOwner?.position ?? null;
    const observations = arcBias?.observations ?? this.collectTacticalObservations(primary);
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

    const selection = arcBias?.selection ?? null;
    const previous = this.lastTracePosition;
    const displacement = previous
      ? Math.hypot(botPos.x - previous.x, botPos.z - previous.z)
      : 0;
    const actualBearingRad = previous && displacement >= 0.05
      ? threatBearingRad(previous, botPos)
      : null;
    const destination = movement.destination;
    const stateKey = JSON.stringify({
      mode: this.mode,
      primary: primary?.id ?? primary?.name ?? null,
      threats: threats.map((threat) => threat.id ?? threat.name),
      owner: ownerPos ? this.tracePosition(ownerPos) : null,
      latch: this.arcNarrowLatched,
      moved: selection?.moved ?? false,
      intent: intent.priority,
      dodge: movement.dodgePhase
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
      arc: arcBias ? {
        spanDeg: traceDegrees(arcBias.spanRad, false),
        midBearingDeg: traceDegrees(arcBias.midRad),
        latched: this.arcNarrowLatched,
        threatCount: arcBias.threatCount,
        tacticalRadius: this.tacticalObservationRadius(),
        rangedThreatCount: arcBias.rangedThreatCount
      } : null,
      candidate: selection ? {
        moved: selection.moved,
        improvement: traceNumber(selection.improvement, 3),
        current: this.tracePositionEvaluation(selection.current),
        chosen: this.tracePositionEvaluation(selection.chosen)
      } : null,
      destination: destination ? this.tracePosition(destination) : null,
      intent,
      dodge: {
        phase: movement.dodgePhase,
        burstRemainingMs: movement.burstRemainingMs,
        advanceRemainingMs: movement.advanceRemainingMs
      },
      movement: {
        kind: movement.kind,
        commandedBearingDeg: movement.bearingRad == null
          ? null
          : traceDegrees(movement.bearingRad),
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

  private tracePositionEvaluation(evaluation: ThreatArcBias['selection']['current']): object {
    return {
      position: this.tracePosition(evaluation.position),
      spanDeg: traceDegrees(evaluation.spanRad, false),
      minEnemyDistance: traceNumber(evaluation.minEnemyDistance),
      moveDistance: traceNumber(evaluation.moveDistance),
      dangerPenalty: traceNumber(evaluation.dangerPenalty, 3),
      ownerPenalty: traceNumber(evaluation.ownerPenalty, 3),
      movementPenalty: traceNumber(evaluation.movementPenalty, 3),
      score: traceNumber(evaluation.score, 3)
    };
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
        this.focusUntil = now + this.activePresetParams.focusStickyMs;
      }
    } else if (canSwitch && stickyTarget) {
      const candidate = pickProtectTarget(
        this.bot,
        ownerPos,
        ranges,
        hasLos,
        this.lastOwnerThreat
      );
      if (candidate && candidate.id !== stickyTarget.id) {
        this.currentTarget = candidate;
        this.syncCombatLearning(candidate, now);
        this.lastTargetSeenAt = now;
        this.focusUntil = now + this.activePresetParams.focusStickyMs;
      }
    }
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

  /**
   * awaitせず、mineflayer-pvpの対象を `enemy` に設定・維持する。
   * 対象オブジェクト変更時に `pvp.attack` が `stop()` を最大5秒待つ場合がある。
   * ここでawaitすると相棒ループが止まり、FollowがBotを再取得してしまう。
   */
  private ensureAttackTarget(enemy: any): void {
    const pvp = this.bot.pvp as {
      target?: { id?: number } | null;
      attack?: (e: any) => Promise<void> | void;
    } | undefined;
    if (!pvp?.attack || !enemy) return;
    if (pvp.target?.id != null && enemy.id != null && pvp.target.id === enemy.id) {
      return;
    }
    void Promise.resolve(pvp.attack(enemy)).catch((err: any) => {
      console.warn('[reflexes] defend failed:', (err as Error)?.message || err);
    });
  }

  /**
   * 近接距離内ではbot.attackで直接攻撃し、間合い制御やpathfinder所有権により
   * 対象の前で棒立ちになることを防ぐ。
   */
  private meleeAssistStrike(enemy: any | null, now: number): void {
    if (!enemy?.position || !this.bot.entity) return;
    const dist = distanceToPos(this.bot.entity.position, enemy.position);
    if (dist > RETREAT_MELEE_RANGE) return;
    if (now - this.lastPassiveStrikeAt < 1000) return;
    this.lastPassiveStrikeAt = now;
    try {
      const look = enemy.position.offset?.(0, (enemy.height ?? 1.8) * 0.9, 0) || enemy.position;
      void this.bot.lookAt?.(look, true);
      this.bot.attack?.(enemy);
    } catch {
      /* 失敗は無視する */
    }
  }

  private stopCombat(): void {
    if (this.fighting) return;
    this.arcNarrowLatched = false;
    this.arcRepositionUntil = 0;
    this.rangedDodgeLatch = idleRangedDodgeLatch();
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

  /** モードを増やさず、直近の爆発脅威から離れる。 */
  private moveAwayFrom(threat: any, movement?: CombatMovement): void {
    if (!movement || !threat?.position) return;
    const botPos = this.bot.entity.position;
    let dx = botPos.x - threat.position.x;
    let dz = botPos.z - threat.position.z;
    const horizontalDistance = Math.hypot(dx, dz);
    if (horizontalDistance < 0.1) {
      dx = -Math.sin(this.bot.entity.yaw);
      dz = -Math.cos(this.bot.entity.yaw);
    } else {
      dx /= horizontalDistance;
      dz /= horizontalDistance;
    }
    const crowdAway = crowdAwayDirection(
      this.bot.entities,
      botPos,
      this.config.hostile_range + TARGET_RANGE_BUFFER,
      isHostile
    );
    const blended = blendCrowdAvoidDirection({
      awayFromTarget: { x: dx, z: dz },
      awayFromCrowd: crowdAway,
      bias: this.activePresetParams.crowdAvoidBias
    });
    const destination = {
      x: botPos.x + blended.x * this.config.retreat_distance,
      y: botPos.y,
      z: botPos.z + blended.z * this.config.retreat_distance
    };
    movement.goToward(destination, RETREAT_GOAL_RANGE);
  }

  private shouldEvadeCreeper(enemy: any): boolean {
    if (!this.isIgnitedCreeper(enemy)) return false;
    const pvp = this.bot.pvp as any;
    return typeof pvp?.hasShield !== 'function' || !pvp.hasShield();
  }

  private isIgnitedCreeper(enemy: any): boolean {
    return enemy?.name === 'creeper' && enemy.metadata?.[16] === 1;
  }

  private configureCombatRange(enemy: any): void {
    if (!this.bot.pvp) return;
    const enemyClass = classifyEnemy(enemy.name);
    const distance = enemy.position
      ? distanceToPos(this.bot.entity.position, enemy.position)
      : this.activePresetParams.followRange;
    const decision = decideSpacing({
      params: this.activePresetParams,
      enemyClass,
      distance,
      enemyFacingBot: null
    });
    this.bot.pvp.followRange = decision.followRange;
  }

  /** 有効なプリセットの間合い制御をmineflayer-pvpへ重ねる。 */
  private applyCombatSpacing(
    enemy: any,
    arcBias: ThreatArcBias | null = null
  ): CombatMovementTrace {
    const idleTrace = this.idleMovementTrace();
    if (!enemy?.position || !this.bot.entity) return idleTrace;
    const now = Date.now();
    const botPos = this.bot.entity.position;
    const distance = distanceToPos(botPos, enemy.position);
    const dx = enemy.position.x - botPos.x;
    const dz = enemy.position.z - botPos.z;
    const enemyFacingBot = facingDot(enemy.yaw, -dx, -dz);
    const enemyClass = classifyEnemy(enemy.name);
    const decision = decideSpacing({
      params: this.activePresetParams,
      enemyClass,
      distance,
      enemyFacingBot
    });

    const bias = arcBias ?? this.collectThreatArcBias(enemy);
    const wideMultiThreat = bias != null
      && bias.threatCount >= 2
      && bias.spanRad >= TARGET_THREAT_SPAN_RAD;
    const arcGuidedStrafe = wideMultiThreat;
    const rangedThreatBearing = bias && bias.rangedThreatCount > 0
      ? bias.midRad
      : enemyClass === 'ranged'
        ? threatBearingRad(botPos, enemy.position)
        : null;
    const dodgeBurst = decideRangedDodgeBurst({
      now,
      underRangedPressure: rangedThreatBearing != null,
      distanceToPrimary: distance,
      meleeAttackRange: RETREAT_MELEE_RANGE,
      latch: this.rangedDodgeLatch,
      lastDamageAt: this.lastDamageAt,
      burstMs: this.activePresetParams.rangedDodgeBurstMs,
      advanceMs: this.activePresetParams.rangedDodgeReassessMs
    });
    this.rangedDodgeLatch = dodgeBurst.latch;
    const needStrafe = arcGuidedStrafe
      ? false
      : (decision.needStrafe
        || (bias != null && bias.spanRad >= WIDE_THREAT_SPAN_RAD));
    const movementTrace: CombatMovementTrace = {
      ...idleTrace,
      dodgePhase: dodgeBurst.phase,
      burstRemainingMs: Math.max(0, dodgeBurst.latch.burstUntil - now),
      advanceRemainingMs: Math.max(0, dodgeBurst.latch.advanceUntil - now)
    };

    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('jump', false);

    if (rangedThreatBearing != null && dodgeBurst.dodge) {
      movementTrace.kind = 'dodge';
      movementTrace.bearingRad = this.applyPerpendicularDodge(rangedThreatBearing, now);
    } else if (rangedThreatBearing != null && dodgeBurst.phase === 'advance') {
      // pvpの移動入力を解除した後、tick間の復帰に任せず共通脅威方向への
      // 前進を明示的に確定する。
      this.applyBearingMovement(rangedThreatBearing);
      movementTrace.kind = 'advance';
      movementTrace.bearingRad = rangedThreatBearing;
      movementTrace.destination = {
        x: enemy.position.x,
        y: enemy.position.y,
        z: enemy.position.z
      };
    } else if (rangedThreatBearing != null) {
      // 攻撃距離では遠距離間合い制御より攻撃を優先し、横移動へ流さず
      // pvp対象と近接補助のため移動入力を空ける。
      movementTrace.kind = 'none';
    } else if (rangedThreatBearing == null && arcGuidedStrafe && bias != null) {
      this.strafeSign = bias.sign;
      this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
      movementTrace.kind = 'strafe';
      movementTrace.bearingRad = this.strafeBearingToward(enemy);
      this.applyStrafeControls(this.strafeSign, movementTrace.bearingRad);
    } else if (needStrafe && bias != null) {
      if (bias.spanRad >= TARGET_THREAT_SPAN_RAD) {
        this.strafeSign = bias.sign;
        this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
      } else if (now >= this.strafeUntil) {
        this.strafeSign = this.strafeSign === 1 ? -1 : 1;
        this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
      }
      movementTrace.kind = 'strafe';
      movementTrace.bearingRad = this.strafeBearingToward(enemy);
      this.applyStrafeControls(this.strafeSign, movementTrace.bearingRad);
    } else if (needStrafe && now >= this.strafeUntil) {
      this.strafeSign = this.strafeSign === 1 ? -1 : 1;
      this.strafeUntil = now + this.activePresetParams.strafeSwitchMs;
      movementTrace.kind = 'strafe';
      movementTrace.bearingRad = this.strafeBearingToward(enemy);
      this.applyStrafeControls(this.strafeSign, movementTrace.bearingRad);
    }
    if (movementTrace.bearingRad != null && movementTrace.kind !== 'none') {
      const displacement = this.combatDisplacement(now);
      const stepAhead = stepAheadAlongBearing(this.bot, movementTrace.bearingRad) != null;
      this.maybeFlipStuckStrafe(stepAhead, displacement, now);
    }
    // 密着距離で後退入力を維持すると攻撃が中断されるため、入力しない。
    if (decision.needBackstep && distance > MELEE_COMMIT_RANGE && rangedThreatBearing == null) {
      this.bot.setControlState('back', true);
    }
    if (this.bot.pvp) this.bot.pvp.followRange = decision.followRange;
    return movementTrace;
  }

  /**
   * 2体以上の護衛脅威が広い角度にいる場合、owner leash内で敵集団を回り込み、
   * 可能なら敵列の片端より外側へ抜ける安全な経路を選ぶ。
   */
  private collectThreatArcBias(primary: any): ThreatArcBias | null {
    if (!this.bot.entity || !primary?.position) return null;
    const botPos = this.bot.entity.position;
    const ownerPos = this.lastDefendOwner?.position ?? null;
    const ranges = this.protectRanges();
    const observations = this.collectTacticalObservations(primary);
    const threats = observations.map(({ entity }) => ({
      x: entity.position.x,
      z: entity.position.z
    }));
    const rangedThreatCount = observations.filter(({ entity }) => isRangedEntity(entity)).length;
    const arc = computeThreatArc(
      { x: botPos.x, z: botPos.z },
      threats
    );
    if (!arc) return null;
    const currentOwnerDistance = ownerPos ? distanceToPos(botPos, ownerPos) : 0;
    const tacticalOwnerLeash = arc.spanRad >= WIDE_THREAT_SPAN_RAD
      ? Math.max(
          ranges.ownerProtectRange,
          currentOwnerDistance + WIDE_REPOSITION_OWNER_ALLOWANCE
        )
      : ranges.ownerProtectRange;

    const selection = chooseBestThreatPosition(
      { x: botPos.x, z: botPos.z },
      threats,
      {
        step: 2.25,
        minEnemyDistance: MELEE_COMMIT_RANGE,
        minimumImprovement:
          (this.activePresetParams.positioningImprovementMarginDeg * Math.PI) / 180,
        ownerPos: ownerPos ? { x: ownerPos.x, z: ownerPos.z } : null,
        maxOwnerDistance: tacticalOwnerLeash
      }
    );

    const sign = strafeSignForOpenArc({
      botPos: { x: botPos.x, z: botPos.z },
      primaryPos: { x: primary.position.x, z: primary.position.z },
      arc,
      ownerPos: ownerPos ? { x: ownerPos.x, z: ownerPos.z } : null,
      ignoreOwnerLeash: arc.spanRad >= WIDE_THREAT_SPAN_RAD
    });

    return {
      sign,
      spanRad: arc.spanRad,
      midRad: arc.midRad,
      destination: selection.moved ? selection.chosen.position : null,
      threatCount: threats.length,
      rangedThreatCount,
      observations,
      selection
    };
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
      this.recentDamageUntil = now + 4000;
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

    const torch = this.bot.inventory.items().find((i) => i.name === 'torch');
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

function facingDot(yaw: number | undefined, dx: number, dz: number): number | null {
  if (!Number.isFinite(yaw)) return null;
  const length = Math.hypot(dx, dz);
  if (length === 0) return 1;
  const facingX = -Math.sin(yaw as number);
  const facingZ = -Math.cos(yaw as number);
  return Number(((facingX * dx + facingZ * dz) / length).toFixed(3));
}
