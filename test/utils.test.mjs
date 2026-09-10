import assert from 'node:assert/strict';
import test from 'node:test';

import { randomString, waitFor } from '../lib/utils.js';

test('waitFor stops before it calls the predicate when the signal is aborted', async () => {
  const controller = new AbortController();
  let calls = 0;
  controller.abort();

  const result = await waitFor(
    () => {
      calls++;
      return false;
    },
    10,
    1,
    controller.signal,
  );

  assert.equal(result, false);
  assert.equal(calls, 0);
});

test('waitFor stops when the signal aborts during a poll delay', async () => {
  const controller = new AbortController();
  let calls = 0;
  setTimeout(() => controller.abort(), 1);

  const result = await waitFor(
    () => {
      calls++;
      return false;
    },
    10,
    1,
    controller.signal,
  );

  assert.equal(result, false);
  assert.equal(calls, 1);
});

test('randomString uses secure random bytes', (t) => {
  t.mock.method(Math, 'random', () => {
    throw new Error('Math.random must not be used');
  });

  const token = randomString(32);

  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});
