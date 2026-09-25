import { describe, expect, it } from 'vitest';

import { parseDuration } from './duration.js';

describe('parseDuration', () => {
  it('passes numbers and undefined through', () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(45)).toBe(45);
  });

  it('parses bare digits as seconds', () => {
    expect(parseDuration('45')).toBe(45);
  });

  it('scales units', () => {
    expect(parseDuration('2m')).toBe(120);
    expect(parseDuration('1h')).toBe(3_600);
    expect(parseDuration('1d')).toBe(86_400);
  });

  it('rejects malformed durations', () => {
    expect(() => parseDuration('1x')).toThrow('Invalid duration: 1x');
    expect(() => parseDuration('-1s')).toThrow('Invalid duration: -1s');
  });
});
