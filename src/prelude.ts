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

export function omitUndefined<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([_, value]) => value !== undefined)) as T;
}

export function getEnv(name: string) {
  if (isDefined(typeof process)) {
    return process.env[name];
  }
}
