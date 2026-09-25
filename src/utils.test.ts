import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDefinition, waitFor } from './utils.js';

describe('buildDefinition region resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads KOYEB_REGION when opts.region is unset', () => {
    vi.stubEnv('KOYEB_REGION', 'fra');
    const { definition } = buildDefinition({ name: 'pool', image: 'koyeb/sandbox:slim' });
    expect(definition.regions).toEqual(['fra']);
  });

  it('prefers opts.region over KOYEB_REGION', () => {
    vi.stubEnv('KOYEB_REGION', 'fra');
    const { definition } = buildDefinition({
      name: 'pool',
      image: 'koyeb/sandbox:slim',
      region: 'par',
    });
    expect(definition.regions).toEqual(['par']);
  });

  it('falls back to the default region when neither is set', () => {
    const saved = process.env.KOYEB_REGION;
    delete process.env.KOYEB_REGION;
    try {
      const { definition } = buildDefinition({ name: 'pool', image: 'koyeb/sandbox:slim' });
      expect(definition.regions).toEqual(['na']);
    } finally {
      if (saved !== undefined) {
        process.env.KOYEB_REGION = saved;
      }
    }
  });
});

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
});
