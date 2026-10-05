export type Duration = number | `${number}${'s' | 'm' | 'h' | 'd'}`;

export function parseDuration(input: undefined | number | string): number | undefined {
  if (input === undefined || typeof input === 'number') {
    return input;
  }

  const match = /^(\d+)(s|m|h|d)?$/.exec(input.trim());

  if (!match) {
    throw new Error(`Invalid duration: ${input}`);
  }

  const value = Number(match[1]);
  // A bare digit string means seconds; a missing unit key must not disable the delay.
  const unit = (match[2] ?? 's') as 's' | 'm' | 'h' | 'd';

  return {
    s: value,
    m: value * 60,
    h: value * 60 * 60,
    d: value * 60 * 60 * 24,
  }[unit];
}
