import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitFor, waitForPhased } from './time.js';

describe('waitFor backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('doubles the delay from startInterval up to the interval', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = waitFor(() => ++calls >= 5, 10, 4, undefined, 0.1);

    // Calls land at t=0, 100ms, 300ms, 700ms, 1500ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(5);
    await expect(pending).resolves.toBe(true);
  });

  it('caps the delay at the steady interval', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = waitFor(() => ++calls >= 7, 30, 1, undefined, 0.1);

    // 0.1, 0.2, 0.4, 0.8, then capped at 1s.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls).toBe(4);

    await vi.advanceTimersByTimeAsync(2_001);
    expect(calls).toBe(7);
    await expect(pending).resolves.toBe(true);
  });

  it('keeps the fixed interval when startInterval is omitted', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = waitFor(() => ++calls >= 3, 10, 1);

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toBe(3);
    await expect(pending).resolves.toBe(true);
  });

  it('advances phases without sleeping between them', async () => {
    vi.useFakeTimers();
    const gate: number[] = [];
    const phaseCalls = [0, 0];
    const pending = waitForPhased(
      [
        async () => {
          phaseCalls[0]++;
          return gate.length > 0;
        },
        async () => {
          phaseCalls[1]++;
          return true;
        },
      ],
      10,
      1,
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(phaseCalls).toEqual([1, 0]);

    gate.push(1);
    await vi.advanceTimersByTimeAsync(500); // fixed 1s interval: next poll due at t=1000
    // The phase advanced and completed in the same poll, with no sleep between.
    expect(phaseCalls).toEqual([2, 1]);
    await expect(pending).resolves.toBe(true);
  });

  it('keeps polling the current phase with warm-up doubling', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = waitForPhased([() => ++calls >= 5], 10, 4, undefined, 0.1);

    // Calls land at t=0, 100ms, 300ms, 700ms, 1500ms — same curve as waitFor.
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(3);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(5);
    await expect(pending).resolves.toBe(true);
  });

  it('returns false when the last phase never completes', async () => {
    vi.useFakeTimers();
    const pending = waitForPhased([async () => false, async () => true], 0.05, 0.01);

    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe(false);
  });

  it('keeps the fixed interval when startInterval is omitted', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = waitFor(() => ++calls >= 3, 10, 1);

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toBe(3);
    await expect(pending).resolves.toBe(true);
  });
});
