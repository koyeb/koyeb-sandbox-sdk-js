/**
 * Sidecars: trusted helper services that run next to a sandbox.
 *
 * A sidecar is a separate service, with its own image, env, secrets and egress
 * policy, that the sandbox reaches by name over a private mesh
 * (`http://<name>:<port>`). Secrets given to a sidecar never enter the sandbox, so
 * a sidecar can hold API keys, run a credential-injecting proxy, or host a helper
 * service the agent should use but not touch.
 *
 * Each sidecar runs as a web service with no public route, a TCP health check on
 * its first port, and the mesh enabled with app scope. Since the sandbox owns its
 * app, the app scope makes the mesh private to the sandbox and its sidecars.
 *
 * The `Sidecar` fields and the `Sandbox` sidecar API are stable. How sidecars are
 * hosted is not: today they are services in the sandbox's app, which
 * `SidecarInfo.service_id` reflects and which may change when the platform runs
 * sidecars natively (Python-SDK parity).
 */

import type { koyeb } from './api.js';
import { buildEgressPolicy, findOverlap } from './cidr.js';
import { buildDefinition, type ConfigFile, type EnvValue } from './definition.js';
import { EgressPolicyError, SidecarError } from './errors.js';

// A DNS label the API accepts as a service name: the sandbox reaches the sidecar
// at http://<name>:<port>. The API's slug rule allows no empty segment, so no "--"
// (and no "."; it would break the DNS name).
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_PORT = 1;
const MAX_PORT = 64999; // the API reserves ports above 65000
const MAX_PORTS = 5;
const MIN_GRACE = 5;
const MAX_GRACE = 900; // API bounds for the health check grace_period

/** Options for a {@link Sidecar}. */
export type SidecarOptions = {
  /** DNS name the sandbox uses to reach the sidecar. Lowercase letters, digits and dashes, 2-63 characters. */
  name: string;
  /** Docker image to run. */
  image: string;
  /**
   * TCP ports the sidecar listens on (1-5). The first port is health-checked: the
   * sandbox is created only once it accepts connections.
   */
  ports: number[];
  /** Instance type (default: `nano`). */
  instance_type?: string;
  /** Override the image entrypoint. */
  entrypoint?: string[];
  /** Override the image command. */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /**
   * Environment variables. Use secret references (`{ name: 'my-secret' }`) so the
   * platform injects secrets at deploy time; they never reach the sandbox.
   */
  env?: Record<string, EnvValue>;
  /** Files to mount, as `{ path: content }` or `{ path: { content, permissions } }`. */
  config_files?: Record<string, EnvValue | ConfigFile>;
  /** Secret holding registry credentials for a private image. */
  registry_secret?: string;
  /** Block all outbound traffic from the sidecar. */
  block_network?: boolean;
  /**
   * IPs/CIDRs the sidecar may reach; everything else is blocked. Mutually exclusive
   * with `block_network`. Entries must not overlap. With either option the sandbox
   * can still reach the sidecar and get replies, but the sidecar can't open new
   * connections to the sandbox.
   */
  outbound_allowlist?: string[];
  /**
   * Run the sidecar privileged (default: false), e.g. for a VPN client that needs
   * /dev/net/tun. Honoured where a privileged sandbox is.
   */
  privileged?: boolean;
  /**
   * Seconds the sidecar may take to start listening before failed health checks
   * count (5-900, default: the platform's, 5). The platform then allows about two
   * more minutes. Raise it for images that install or configure things at boot.
   */
  startup_grace_period?: number;
};

/**
 * A trusted helper service that runs next to a sandbox.
 *
 * Pass sidecars to `Sandbox.create({ sidecars: [...] })`. The sandbox reaches each
 * one at `http://<name>:<port>` over a private mesh. Invalid options throw
 * {@link SidecarError} at construction.
 *
 * @example
 * const proxy = new Sidecar({
 *   name: 'proxy',
 *   image: 'mitmproxy/mitmproxy:latest',
 *   ports: [8080],
 *   command: 'mitmdump',
 *   args: ['--listen-port', '8080'],
 *   env: { API_KEY: { name: 'my-api-key' } },
 * });
 */
export class Sidecar {
  readonly name: string;
  readonly image: string;
  readonly ports: readonly number[];
  readonly instance_type: string;
  readonly entrypoint?: string[];
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, EnvValue>;
  readonly config_files?: Record<string, EnvValue | ConfigFile>;
  readonly registry_secret?: string;
  readonly block_network: boolean;
  readonly outbound_allowlist?: string[];
  readonly privileged: boolean;
  readonly startup_grace_period?: number;

  constructor(options: SidecarOptions) {
    validateName(options.name);
    this.name = options.name;

    if (typeof options.image !== 'string' || !options.image) {
      throw new SidecarError(`Sidecar '${this.name}': image is required`);
    }
    this.image = options.image;
    this.ports = Object.freeze(validatePorts(this.name, options.ports));

    const grace = options.startup_grace_period;
    if (grace !== undefined && (!Number.isInteger(grace) || grace < MIN_GRACE || grace > MAX_GRACE)) {
      throw new SidecarError(
        `Sidecar '${this.name}': startup_grace_period must be an integer between ${MIN_GRACE} and ${MAX_GRACE} seconds`,
      );
    }

    let egress: koyeb.EgressPolicy | undefined;
    try {
      egress = buildEgressPolicy(options.block_network, options.outbound_allowlist);
    } catch (error) {
      if (error instanceof EgressPolicyError) {
        throw new SidecarError(`Sidecar '${this.name}': ${error.message}`, { cause: error });
      }
      throw error;
    }

    const overlap = findOverlap((egress?.allow_list ?? []).map(({ cidr }) => cidr!));
    if (overlap) {
      throw new SidecarError(
        `Sidecar '${this.name}': outbound_allowlist entries must not overlap (${overlap[0]} and ${overlap[1]})`,
      );
    }

    this.instance_type = options.instance_type ?? 'nano';
    this.entrypoint = options.entrypoint;
    this.command = options.command;
    this.args = options.args;
    this.env = options.env;
    this.config_files = options.config_files;
    this.registry_secret = options.registry_secret;
    this.block_network = options.block_network ?? false;
    this.outbound_allowlist = options.outbound_allowlist;
    this.privileged = options.privileged ?? false;
    this.startup_grace_period = grace;
  }

  /**
   * The deployment definition for this sidecar.
   *
   * A web service with no route (not public), its ports as tcp, a TCP health check
   * on the first port, the mesh enabled with app scope, and no scale-to-zero: mesh
   * traffic from the sandbox does not wake a sleeping service. `region` should
   * match the sandbox's.
   */
  definition(region?: string): koyeb.DeploymentDefinition {
    const { definition } = buildDefinition(
      {
        name: this.name,
        type: 'WEB',
        image: this.image,
        instance_type: this.instance_type,
        region,
        env: this.env,
        config_files: this.config_files,
        privileged: this.privileged,
        registry_secret: this.registry_secret,
        idle_timeout: 0,
        block_network: this.block_network,
        outbound_allowlist: this.outbound_allowlist,
        entrypoint: this.entrypoint,
        command: this.command,
        args: this.args,
        enable_mesh: true,
        mesh_scope: 'MESH_SCOPE_APP',
        ports: this.ports.map((port) => ({ port, protocol: 'tcp' })),
        routes: [],
        health_checks: [
          {
            tcp: { port: this.ports[0] },
            ...(this.startup_grace_period !== undefined && { grace_period: this.startup_grace_period }),
          },
        ],
      },
      { secret: false },
    );

    return definition;
  }
}

/**
 * Check a sandbox's sidecars as a set, before any API call.
 *
 * Names must be unique and differ from the sandbox's name: they share one app, and
 * the sandbox reaches each sidecar by its service name.
 */
export function validateSidecars(sidecars: Iterable<Sidecar>, sandboxName: string): Sidecar[] {
  const list = [...sidecars];
  const seen = new Set<string>();

  for (const sidecar of list) {
    if (!(sidecar instanceof Sidecar)) {
      throw new SidecarError(`Expected a Sidecar, got ${describe(sidecar)}`);
    }
    if (sidecar.name === sandboxName) {
      throw new SidecarError(`Sidecar name '${sidecar.name}' is the sandbox's name; pick another`);
    }
    if (seen.has(sidecar.name)) {
      throw new SidecarError(`Duplicate sidecar name '${sidecar.name}'`);
    }
    seen.add(sidecar.name);
  }

  return list;
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return value.constructor?.name ?? 'object';
  }
  return typeof value;
}

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length < 2 || name.length > 63 || !NAME_RE.test(name)) {
    throw new SidecarError(
      `Invalid sidecar name ${JSON.stringify(name)}: use 2-63 lowercase letters, digits and single dashes, starting and ending with a letter or digit`,
    );
  }
}

export function validatePorts(name: string, ports: unknown): number[] {
  if (!Array.isArray(ports)) {
    throw new SidecarError(`Sidecar '${name}': ports must be a list of integers`);
  }
  if (ports.length < 1 || ports.length > MAX_PORTS) {
    throw new SidecarError(`Sidecar '${name}': declare between 1 and ${MAX_PORTS} ports`);
  }
  for (const port of ports) {
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new SidecarError(
        `Sidecar '${name}': port ${JSON.stringify(port)} must be an integer between ${MIN_PORT} and ${MAX_PORT}`,
      );
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new SidecarError(`Sidecar '${name}': duplicate port`);
  }
  return [...ports];
}
