export function isUndefined<T>(value: T | undefined): value is undefined {
  return value === undefined;
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function assert(condition: unknown, error = new Error('Assertion failed')): asserts condition {
  if (!condition) {
    throw error;
  }
}

export function createArray<T>(length: number, init: (index: number) => T) {
  return Array(length)
    .fill(null)
    .map((_, index) => init(index));
}

export function randomFloat(max: number) {
  return Math.random() * max;
}

export function randomInteger(max: number) {
  return Math.floor(randomFloat(max));
}

export function randomItem<T>(items: T[]) {
  return items[randomInteger(items.length - 1)];
}

export function wait(ms: number, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(true), ms);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    }
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout: number,
  interval: number,
  signal?: AbortSignal,
) {
  const start = Date.now();

  do {
    if (await predicate()) {
      return true;
    }

    await wait(interval, signal);
  } while (Date.now() - start < timeout);

  return false;
}

export function getEnv(name: string) {
  if (isDefined(typeof process)) {
    return process.env[name];
  }
}

export function nanoId(alphabet: string) {
  const letters = alphabet.split('');

  return (length: number) => {
    return createArray(length, () => randomItem(letters)).join('');
  };
}

export const randomString = nanoId('-_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

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
  const unit = match[2] as 's' | 'm' | 'h' | 'd';

  return {
    s: value,
    m: value * 60,
    h: value * 60 * 60,
    d: value * 60 * 60 * 24,
  }[unit];
}
