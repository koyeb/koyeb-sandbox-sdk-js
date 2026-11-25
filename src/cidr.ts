import net from 'node:net';

import type { koyeb } from './api.js';
import { EgressPolicyError } from './errors.js';

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
  for (let start = 0; start < 8;) {
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
 * The first pair of overlapping CIDRs in a list, or `undefined` when they are disjoint.
 * Entries must already be normalized (see {@link buildEgressPolicy}).
 */
export function findOverlap(cidrs: string[]): [string, string] | undefined {
  const nets = cidrs.map((cidr) => {
    const [address, prefix] = cidr.split('/');
    const ip = parseIp(address)!;
    const width = ip.version === 4 ? 32 : 128;
    const hostBits = BigInt(width - Number(prefix));
    return { cidr, version: ip.version, start: ip.bits, end: ip.bits | ((1n << hostBits) - 1n) };
  });

  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      const a = nets[i];
      const b = nets[j];

      if (a.version === b.version && a.start <= b.end && b.start <= a.end) {
        return [a.cidr, b.cidr];
      }
    }
  }

  return undefined;
}

/** Mesh scopes `mesh_scope` accepts. CUSTOM needs a mesh name and is not supported. */
export type MeshScope = 'MESH_SCOPE_APP' | 'MESH_SCOPE_WORKSPACE' | 'MESH_SCOPE_ORGANIZATION';

const MESH_SCOPES: readonly string[] = ['MESH_SCOPE_APP', 'MESH_SCOPE_WORKSPACE', 'MESH_SCOPE_ORGANIZATION'];

/**
 * Validate a `mesh_scope` value. `undefined` and `MESH_SCOPE_UNSPECIFIED` both mean
 * "organization default" and return `undefined`.
 *
 * @throws {Error} If the scope is CUSTOM or unknown.
 */
export function normalizeMeshScope(scope: string | undefined): MeshScope | undefined {
  if (scope === undefined || scope === 'MESH_SCOPE_UNSPECIFIED') {
    return undefined;
  }

  if (scope === 'MESH_SCOPE_CUSTOM') {
    throw new Error('mesh_scope MESH_SCOPE_CUSTOM needs a mesh name; not supported');
  }

  if (!MESH_SCOPES.includes(scope)) {
    throw new Error(`Invalid mesh_scope: ${JSON.stringify(scope)}`);
  }

  return scope as MeshScope;
}

/**
 * Build the egress part of a {@link koyeb.NetworkPolicy}, or `undefined` when both
 * arguments are unset. See {@link buildNetworkPolicy} for the arguments.
 */
export function buildEgressPolicy(
  blockNetwork = false,
  outboundAllowlist?: string[],
): koyeb.EgressPolicy | undefined {
  if (blockNetwork && outboundAllowlist !== undefined) {
    throw new EgressPolicyError('block_network and outbound_allowlist are mutually exclusive; pass at most one');
  }

  if (!blockNetwork && outboundAllowlist === undefined) {
    return undefined;
  }

  const allow_list = outboundAllowlist?.map((entry) => ({ cidr: normalizeDestination(entry) }));

  return { mode: 'EGRESS_POLICY_MODE_DENY_ALL', allow_list };
}

/**
 * Build a {@link koyeb.NetworkPolicy} from sandbox network arguments.
 *
 * Returns `undefined` when every argument is unset (leaving the platform default,
 * unrestricted outbound access). `blockNetwork` denies all outbound traffic; an
 * `outboundAllowlist` denies all traffic except the listed IPs/CIDRs (an empty list
 * denies everything). The two are mutually exclusive. `meshScope` selects which
 * services share the mesh; unset keeps the organization default.
 *
 * @throws {EgressPolicyError} If both egress arguments are passed, or an allowlist entry
 *   is not a valid IP address or CIDR.
 * @throws {Error} If `meshScope` is CUSTOM or unknown.
 */
export function buildNetworkPolicy(
  blockNetwork = false,
  outboundAllowlist?: string[],
  meshScope?: string,
): koyeb.NetworkPolicy | undefined {
  const scope = normalizeMeshScope(meshScope);
  const egress = buildEgressPolicy(blockNetwork, outboundAllowlist);

  if (egress === undefined && scope === undefined) {
    return undefined;
  }

  return { ...(egress && { egress }), ...(scope && { mesh: { scope } }) };
}

/**
 * Carry the current mesh scope into a new network policy.
 *
 * `update_network_policy` only changes egress; replacing the whole network policy
 * would silently move the sandbox to another mesh.
 */
export function keepMesh(
  policy: koyeb.NetworkPolicy,
  current: koyeb.NetworkPolicy | undefined,
): koyeb.NetworkPolicy {
  return current?.mesh ? { ...policy, mesh: current.mesh } : policy;
}
