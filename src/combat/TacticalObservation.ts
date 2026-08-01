import { isHostile } from '../world/entities.js';

export type TacticalPosition = {
  x: number;
  y?: number;
  z: number;
  distanceTo?: (other: any) => number;
};

export type TacticalThreatObservation = {
  entity: any;
  source: 'primary' | 'nearby-visible';
  distance: number;
};

/** 交戦中の位置取りにだけ使う、Bot中心の観測半径。 */
export const DEFAULT_TACTICAL_OBSERVATION_RADIUS = 8;

/**
 * 対象取得用protectPolicyとは独立した、交戦中の戦術観測集合を返す。
 * primaryは一時的にLOSや距離を外れても維持し、追加脅威は半径・LOS・hostileで制限する。
 */
export function collectTacticalThreatObservations(opts: {
  botPos: TacticalPosition;
  primary: any | null | undefined;
  entities: Iterable<any>;
  radius?: number;
  hasLineOfSight: (entity: any) => boolean;
}): TacticalThreatObservation[] {
  const radius = Math.max(0, opts.radius ?? DEFAULT_TACTICAL_OBSERVATION_RADIUS);
  const observations: TacticalThreatObservation[] = [];
  const seen = new Set<string>();

  const add = (entity: any, source: TacticalThreatObservation['source']) => {
    if (!isObservableHostile(entity)) return;
    const key = entityKey(entity);
    if (seen.has(key)) return;
    seen.add(key);
    observations.push({
      entity,
      source,
      distance: distanceBetween(opts.botPos, entity.position)
    });
  };

  add(opts.primary, 'primary');
  for (const entity of opts.entities) {
    if (!isObservableHostile(entity)) continue;
    if (distanceBetween(opts.botPos, entity.position) > radius) continue;
    if (!opts.hasLineOfSight(entity)) continue;
    add(entity, 'nearby-visible');
  }

  observations.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'primary' ? -1 : 1;
    if (Math.abs(a.distance - b.distance) > 1e-6) return a.distance - b.distance;
    return entityKey(a.entity).localeCompare(entityKey(b.entity));
  });
  return observations;
}

function isObservableHostile(entity: any): boolean {
  return Boolean(
    entity?.position
    && entity.isValid !== false
    && isHostile(entity)
  );
}

function entityKey(entity: any): string {
  if (entity?.id != null) return `id:${String(entity.id)}`;
  return `name:${String(entity?.name ?? '')}:${entity?.position?.x ?? ''}:${entity?.position?.z ?? ''}`;
}

function distanceBetween(a: TacticalPosition, b: TacticalPosition): number {
  if (typeof a.distanceTo === 'function') return a.distanceTo(b);
  return Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);
}
