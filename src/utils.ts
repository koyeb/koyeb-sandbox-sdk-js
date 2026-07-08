import net from 'node:net';
import type { koyeb } from './api.js';
import { EgressPolicyError } from './errors.js';
import type { ConfigFile, EnvValue } from './sandbox.js';

export const DEFAULT_CONFIG_FILE_PERMISSIONS = '0644';

/**
 * Render an environment / config-file value to its on-the-wire string.
 *
 * - `string` is returned verbatim (server interpolates `{{ X }}` and `{{ secret.foo }}`).
 * - An object with `name` (including a full `koyeb.Secret`) becomes `"{{ secret.<name> }}"`.
 */
export function renderEnvValue(value: EnvValue): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value.name) {
    throw new Error('Secret reference must have a non-empty `name` field');
  }

  return `{{ secret.${value.name} }}`;
}

export function buildEnvVars(env?: Record<string, EnvValue>): koyeb.DeploymentEnv[] {
  if (!env) {
    return [];
  }

  return Object.entries(env).map(([key, value]) => ({ key, value: renderEnvValue(value) }));
}

function isConfigFile(value: EnvValue | ConfigFile): value is ConfigFile {
  return typeof value === 'object' && value !== null && 'content' in value;
}

export function buildConfigFiles(
  files?: Record<string, EnvValue | ConfigFile>,
): koyeb.ConfigFile[] {
  if (!files) {
    return [];
  }

  return Object.entries(files).map(([path, value]) => {
    if (isConfigFile(value)) {
      return {
        path,
        content: renderEnvValue(value.content),
        permissions: value.permissions ?? DEFAULT_CONFIG_FILE_PERMISSIONS,
      };
    }

    return {
      path,
      content: renderEnvValue(value),
      permissions: DEFAULT_CONFIG_FILE_PERMISSIONS,
    };
  });
}

/**
 * Parse an IPv4 or IPv6 address into a fixed-width integer, or `undefined` when invalid.
 * Zone-scoped addresses (e.g. `fe80::1%eth0`) are rejected by the caller before this runs.
 */
function parseIp(value: string): { version: 4 | 6; bits: bigint } | undefined {
  if (net.isIPv4(value)) {
    const bits = value.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
    return { version: 4, bits };
  }

  if (net.isIPv6(value)) {
    const [head, tail = ''] = value.split('::');

    const toGroups = (part: string): bigint[] =>
      part === ''
        ? []
        : part.split(':').flatMap((group) => {
            if (group.includes('.')) {
              // Embedded IPv4 (e.g. `::ffff:1.2.3.4`) maps to two 16-bit groups.
              const v4 = parseIp(group)!.bits;
              return [(v4 >> 16n) & 0xffffn, v4 & 0xffffn];
            }

            return [BigInt(parseInt(group, 16))];
          });

    const left = toGroups(head);
    const right = toGroups(tail);
    const groups = value.includes('::')
      ? [...left, ...Array<bigint>(8 - left.length - right.length).fill(0n), ...right]
      : left;

    if (groups.length !== 8) {
      return undefined;
    }

    return { version: 6, bits: groups.reduce((acc, group) => (acc << 16n) | group, 0n) };
  }

  return undefined;
}

function formatIp(version: 4 | 6, bits: bigint): string {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => (bits >> shift) & 0xffn).join('.');
  }

  const groups = Array.from({ length: 8 }, (_, i) => Number((bits >> BigInt((7 - i) * 16)) & 0xffffn));

  // Compress the longest run of zero groups per RFC 5952.
  let bestStart = -1;
  let bestLen = 0;
  for (let start = 0; start < 8; ) {
    let end = start;
    while (end < 8 && groups[end] === 0) end++;

    if (end - start > bestLen) {
      bestStart = start;
      bestLen = end - start;
    }

    start = end > start ? end : start + 1;
  }

  const parts = groups.map((group) => group.toString(16));

  if (bestLen < 2) {
    return parts.join(':');
  }

  return `${parts.slice(0, bestStart).join(':')}::${parts.slice(bestStart + bestLen).join(':')}`;
}

/**
 * Normalize an outbound allowlist entry to a CIDR string.
 *
 * Bare IPv4 addresses become `/32`, bare IPv6 addresses become `/128`, and CIDR
 * notation is validated with host bits cleared (e.g. `10.0.0.1/8` -> `10.0.0.0/8`).
 */
function normalizeDestination(entry: string): string {
  const value = typeof entry === 'string' ? entry.trim() : '';

  if (!value) {
    throw new EgressPolicyError(`Invalid outbound_allowlist entry: ${JSON.stringify(entry)}`);
  }

  if (value.includes('%')) {
    throw new EgressPolicyError(
      `Invalid outbound_allowlist entry ${JSON.stringify(entry)}: ` +
        'expected an IP address or CIDR (scoped/zone-ID addresses are not allowed)',
    );
  }

  const invalid = () =>
    new EgressPolicyError(`Invalid outbound_allowlist entry ${JSON.stringify(entry)}: expected an IP address or CIDR`);

  if (value.includes('/')) {
    const [address, prefixPart, ...rest] = value.split('/');

    if (rest.length > 0 || !/^\d+$/.test(prefixPart)) {
      throw invalid();
    }

    const ip = parseIp(address);

    if (!ip) {
      throw invalid();
    }

    const maxPrefix = ip.version === 4 ? 32 : 128;
    const prefix = Number(prefixPart);

    if (prefix > maxPrefix) {
      throw invalid();
    }

    const hostBits = BigInt(maxPrefix - prefix);
    const allOnes = (1n << BigInt(maxPrefix)) - 1n;
    const mask = (allOnes >> hostBits) << hostBits;

    return `${formatIp(ip.version, ip.bits & mask)}/${prefix}`;
  }

  const ip = parseIp(value);

  if (!ip) {
    throw invalid();
  }

  return `${formatIp(ip.version, ip.bits)}/${ip.version === 4 ? 32 : 128}`;
}

/**
 * Build a {@link koyeb.NetworkPolicy} from sandbox egress arguments.
 *
 * Returns `undefined` when both arguments are unset (leaving the platform default,
 * unrestricted outbound access). `blockNetwork` denies all outbound traffic; an
 * `outboundAllowlist` denies all traffic except the listed IPs/CIDRs (an empty list
 * denies everything). The two arguments are mutually exclusive.
 *
 * @throws {EgressPolicyError} If both arguments are passed, or an allowlist entry is
 *   not a valid IP address or CIDR.
 */
export function buildNetworkPolicy(
  blockNetwork = false,
  outboundAllowlist?: string[],
): koyeb.NetworkPolicy | undefined {
  if (blockNetwork && outboundAllowlist !== undefined) {
    throw new EgressPolicyError('block_network and outbound_allowlist are mutually exclusive; pass at most one');
  }

  if (!blockNetwork && outboundAllowlist === undefined) {
    return undefined;
  }

  const allow_list = outboundAllowlist?.map((entry) => ({ cidr: normalizeDestination(entry) }));

  return { egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL', allow_list } };
}

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

    await wait(interval * 1_000, signal);
  } while (Date.now() - start < timeout * 1_000);

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
