import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_LOGIN_MESSAGE,
  DUPLICATE_LOGIN_RETRY_MESSAGE,
  extractKickReason,
  humanizeSpawnFailure,
  isDuplicateLoginError
} from '../src/runtime/spawnErrors.ts';

describe('spawnErrors', () => {
  it('detects duplicate_login from kick / end messages', () => {
    assert.equal(
      isDuplicateLoginError(
        'bot ended before spawn: multiplayer.disconnect.duplicate_login'
      ),
      true
    );
    assert.equal(isDuplicateLoginError('bot ended before spawn: socketClosed'), false);
  });

  it('extracts translate kick reasons', () => {
    assert.equal(
      extractKickReason({ translate: 'multiplayer.disconnect.duplicate_login' }),
      'multiplayer.disconnect.duplicate_login'
    );
  });

  it('humanizes duplicate login with retry / exhausted variants', () => {
    assert.equal(
      humanizeSpawnFailure('bot ended before spawn: multiplayer.disconnect.duplicate_login'),
      DUPLICATE_LOGIN_RETRY_MESSAGE
    );
    assert.equal(
      humanizeSpawnFailure('bot ended before spawn: multiplayer.disconnect.duplicate_login', {
        retriesExhausted: true
      }),
      DUPLICATE_LOGIN_MESSAGE
    );
  });
});
