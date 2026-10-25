import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    FOLLOW_SPRINT_MARGIN,
    OWNER_SPRINT_SPEED,
    SPRINT_MIN_FOOD,
    TRAVEL_SPRINT_DISTANCE,
    shouldSprintForMove
} from '../src/companion/movement/sprintPolicy.js';
import { capParkourToWalkingDistance } from '../src/companion/blockProtection.js';
import { DEFAULT_FOLLOW_DISTANCE } from '../src/companion/movement/followConstants.js';

const followFar = DEFAULT_FOLLOW_DISTANCE + FOLLOW_SPRINT_MARGIN;

describe('スプリントする条件', () => {
    it('追従で設定距離より十分遅れたら走る', () => {
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: followFar,
            ownerSpeed: 0,
            food: 20
        }), true);
    });

    it('追従距離を広げても、その差が付いてから走る', () => {
        const followDistance = 10;
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: followDistance + FOLLOW_SPRINT_MARGIN - 0.1,
            followDistance,
            food: 20
        }), false);
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: followDistance + FOLLOW_SPRINT_MARGIN,
            followDistance,
            food: 20
        }), true);
    });

    it('オーナーが走って離れる追従では、近い遅れでも走る', () => {
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: DEFAULT_FOLLOW_DISTANCE + 1,
            ownerSpeed: OWNER_SPRINT_SPEED,
            food: 20
        }), true);
    });

    it('最後に届いた場所が遠ければ、フォールバック追従でも走る', () => {
        assert.equal(shouldSprintForMove({
            role: 'follow-fallback',
            distance: followFar,
            food: 20
        }), true);
    });

    it('遠い固定の目的地へは走る', () => {
        assert.equal(shouldSprintForMove({
            role: 'seek',
            distance: TRAVEL_SPRINT_DISTANCE,
            food: 20
        }), true);
    });

    it('戦闘か消火が固定したダッシュは、近い移動でも維持する', () => {
        assert.equal(shouldSprintForMove({
            sprintLocked: true,
            role: 'seek',
            distance: 2,
            food: 20
        }), true);
    });
});

describe('歩いたままの条件', () => {
    it('平常の追従（遅れが小さい、相手は歩いている）は歩く', () => {
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: followFar - 0.1,
            ownerSpeed: OWNER_SPRINT_SPEED - 0.1,
            food: 20
        }), false);
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: DEFAULT_FOLLOW_DISTANCE,
            ownerSpeed: OWNER_SPRINT_SPEED + 1,
            food: 20
        }), false);
    });

    it('近い目的地、登り、用途のない移動は歩く', () => {
        assert.equal(shouldSprintForMove({
            role: 'seek',
            distance: TRAVEL_SPRINT_DISTANCE - 0.1,
            food: 20
        }), false);
        assert.equal(shouldSprintForMove({
            role: 'climb',
            distance: 30,
            food: 20
        }), false);
        assert.equal(shouldSprintForMove({
            role: 'other',
            distance: 30,
            food: 20
        }), false);
    });

    it('満腹度が 6 以下なら、遅れても戦闘の固定でも走らない', () => {
        assert.equal(SPRINT_MIN_FOOD, 7);
        assert.equal(shouldSprintForMove({
            role: 'follow',
            distance: followFar,
            food: SPRINT_MIN_FOOD - 1
        }), false);
        assert.equal(shouldSprintForMove({
            sprintLocked: true,
            role: 'seek',
            distance: 40,
            food: 6
        }), false);
    });

    it('満腹度が不明なときは距離の判断を使う', () => {
        assert.equal(shouldSprintForMove({
            role: 'seek',
            distance: TRAVEL_SPRINT_DISTANCE,
            food: null
        }), true);
    });
});

describe('ダッシュ許可は経路の跳躍を伸ばさない', () => {
    it('パルクール探索のあいだだけ allowSprinting を戻す', () => {
        let seen = null;
        const movements = {
            allowSprinting: true,
            getMoveParkourForward() {
                seen = this.allowSprinting;
            }
        };

        capParkourToWalkingDistance(movements);
        movements.getMoveParkourForward({}, {}, []);

        assert.equal(seen, false);
        assert.equal(movements.allowSprinting, true);
        capParkourToWalkingDistance(movements);
        assert.equal(movements._trailmateWalkParkour, true);
    });
});
