import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CombatTrace,
  isCombatTraceEnabled
} from '../src/combat/CombatTrace.js';

describe('CombatTrace', () => {
  it('明示的な指定値の場合だけ有効になる', () => {
    assert.equal(isCombatTraceEnabled({}), false);
    assert.equal(isCombatTraceEnabled({ COMBAT_TRACE: '0' }), false);
    assert.equal(isCombatTraceEnabled({ COMBAT_TRACE: 'true' }), false);
    assert.equal(isCombatTraceEnabled({ COMBAT_TRACE: '1' }), true);
  });

  it('無効時はログを出力しない', () => {
    const lines: string[] = [];
    const trace = new CombatTrace({ enabled: false, logger: (line) => lines.push(line) });
    assert.equal(trace.decision('guard', { mode: 'guard' }, 1000), false);
    assert.equal(trace.event('attack_attempt', { targetId: 4 }, 1000), false);
    assert.deepEqual(lines, []);
  });

  it('状態変化は即時、安定状態はheartbeat時だけ記録する', () => {
    const lines: string[] = [];
    const trace = new CombatTrace({
      enabled: true,
      heartbeatMs: 1000,
      logger: (line) => lines.push(line)
    });

    assert.equal(trace.decision('guard|dodge', { mode: 'guard' }, 1000), true);
    assert.equal(trace.decision('guard|dodge', { mode: 'guard' }, 1500), false);
    assert.equal(trace.decision('guard|dodge', { mode: 'guard' }, 2000), true);
    assert.equal(trace.decision('guard|attack', { mode: 'guard' }, 2100), true);
    assert.equal(lines.length, 3);

    const parsed = JSON.parse(lines[0].slice('[combat-trace] '.length));
    assert.equal(parsed.event, 'decision');
    assert.equal(parsed.mode, 'guard');
    assert.equal(parsed.at, 1000);
  });

  it('代表的な構造化フィールドを含むイベントを出力する', () => {
    const lines: string[] = [];
    const trace = new CombatTrace({ enabled: true, logger: (line) => lines.push(line) });
    trace.event('target_hurt_observed', {
      target: { id: 12, name: 'skeleton' },
      attribution: 'unconfirmed'
    }, 1234);

    assert.match(lines[0], /^\[combat-trace\] /);
    const parsed = JSON.parse(lines[0].slice('[combat-trace] '.length));
    assert.deepEqual(parsed.target, { id: 12, name: 'skeleton' });
    assert.equal(parsed.attribution, 'unconfirmed');
  });

  it('復旧状態変化とheartbeatを戦闘判断から独立して記録する', () => {
    const lines: string[] = [];
    const trace = new CombatTrace({
      enabled: true,
      heartbeatMs: 1000,
      logger: (line) => lines.push(line)
    });

    assert.equal(trace.recovery('items|2', { phase: 'items', remaining: 2 }, 1000), true);
    assert.equal(trace.recovery('items|2', { phase: 'items', remaining: 2 }, 1500), false);
    assert.equal(trace.decision('guard', { mode: 'guard' }, 1500), true);
    assert.equal(trace.recovery('items|1', { phase: 'items', remaining: 1 }, 1600), true);
    assert.equal(trace.recovery('items|1', { phase: 'items', remaining: 1 }, 2600), true);

    const events = lines.map((line) => JSON.parse(line.slice('[combat-trace] '.length)).event);
    assert.deepEqual(events, [
      'recovery_heartbeat',
      'decision',
      'recovery_heartbeat',
      'recovery_heartbeat'
    ]);
  });
});
