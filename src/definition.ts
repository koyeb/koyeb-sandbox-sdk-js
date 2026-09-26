import type { koyeb } from './api.js';
import { DEFAULT_IDLE_TIMEOUT } from './constants.js';
import { randomString } from './id.js';
import { getEnv } from './prelude.js';
import { buildNetworkPolicy } from './cidr.js';

export const DEFAULT_CONFIG_FILE_PERMISSIONS = '0644';

/**
 * Reference to a Koyeb secret by name. A full `koyeb.Secret` object also satisfies this
 * structurally (its `name` field is read at render time).
 */
export type SecretRef = { name?: string };

/**
 * A value usable in `env` or `config_files`.
 *
 * - `string`: passed verbatim. Server-side interpolation (`{{ X }}` and `{{ secret.foo }}`) still applies.
 * - `SecretRef` (e.g. `{ name: "my-secret" }` or a full `koyeb.Secret`): rendered as
 *   `"{{ secret.<name> }}"`.
 */
export type EnvValue = string | SecretRef;

/**
 * Config file with custom permissions. `content` accepts the same forms as env values.
 */
export type ConfigFile = { content: EnvValue; permissions?: string };

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

export function buildConfigFiles(files?: Record<string, EnvValue | ConfigFile>): koyeb.ConfigFile[] {
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
 * Options for building a SANDBOX-type DeploymentDefinition.
 */
export type DefinitionOptions = Partial<{
  name: string;
  type: koyeb.DeploymentDefinitionType;
  image: string;
  instance_type: string;
  region: string;
  env: Record<string, EnvValue>;
  config_files: Record<string, EnvValue | ConfigFile>;
  privileged: boolean;
  registry_secret: string;
  exposed_port_protocol: 'http' | 'http2';
  enable_tcp_proxy: boolean;
  idle_timeout: number;
  _experimental_enable_light_sleep: boolean;
  _experimental_deep_sleep_value: number;
  block_network: boolean;
  outbound_allowlist: string[];
  /** Override the image entrypoint (Python-SDK parity). */
  entrypoint: string[];
  /** Override the image command (Python-SDK parity). */
  command: string;
  /** Arguments passed to the command (Python parity). */
  args: string[];
  /** tri-state mesh toggle: unset = platform default (AUTO), true = ENABLED, false = DISABLED. */
  enable_mesh: boolean;
  /** Use an explicit sandbox secret instead of generating one. */
  sandbox_secret: string;
  /** Explicit member ports, sent verbatim (pool members of non-SANDBOX type). */
  ports: Array<{ port: number; protocol: string }>;
  /** Explicit member routes, sent verbatim (pool members of non-SANDBOX type). */
  routes: Array<{ port: number; path: string }>;
}>;

/**
 * Build a DeploymentDefinition from curated flags. The `type` defaults to
 * SANDBOX but pools may pass other types (WEB, WORKER, DATABASE).
 * Shared by `Sandbox.create` and `ServicePool.create`: in pool mode the
 * definition carries no SDK-generated SANDBOX_SECRET (the platform mints
 * pool secrets) and mesh stays AUTO.
 */
export function buildDefinition(
  opts: DefinitionOptions,
  { pool = false }: { pool?: boolean } = {},
): {
  definition: koyeb.DeploymentDefinition;
  sandbox_secret?: string;
} {
  const network_policy = buildNetworkPolicy(opts.block_network, opts.outbound_allowlist);

  const type = opts.type ?? 'SANDBOX';

  const ports =
    opts.ports ??
    (type === 'SANDBOX'
      ? [
          { port: 3030, protocol: 'http' },
          { port: 3031, protocol: opts.exposed_port_protocol ?? 'http' },
        ]
      : undefined);
  const routes =
    opts.routes ??
    (type === 'SANDBOX'
      ? [
          { port: 3030, path: '/koyeb-sandbox/' },
          { port: 3031, path: '/' },
        ]
      : undefined);

  const definition: koyeb.DeploymentDefinition = {
    name: opts.name,
    type,
    docker: {
      image: opts.image,
      privileged: opts.privileged,
      image_registry_secret: opts.registry_secret,
      entrypoint: opts.entrypoint,
      command: opts.command,
      args: opts.args,
    },
    instance_types: [{ type: opts.instance_type }],
    regions: [opts.region ?? getEnv('KOYEB_REGION') ?? 'na'],
    // Only SANDBOX-typed definitions auto-wire the executor's ports and
    // routes; every other type sends explicit wiring verbatim or none at all.
    ...(ports && { ports }),
    ...(routes && { routes }),
  };

  const sandbox_secret = pool ? undefined : opts.sandbox_secret ?? randomString(32);

  // Pools never inject an SDK-generated secret: user env passes through
  // verbatim and the platform mints one server-side when the definition has none.
  definition.env = [
    ...(sandbox_secret !== undefined ? [{ key: 'SANDBOX_SECRET', value: sandbox_secret }] : []),
    ...buildEnvVars(opts.env),
  ];

  const config_files = buildConfigFiles(opts.config_files);
  if (config_files.length > 0) {
    definition.config_files = config_files;
  }

  if (network_policy) {
    definition.network_policy = network_policy;
  }

  // Tri-state mesh mapping: the field is always sent, unset meaning AUTO
  // (the Python SDK's explicit platform default). Pools have no mesh option
  // and always run AUTO.
  definition.mesh = pool
    ? 'DEPLOYMENT_MESH_AUTO'
    : opts.enable_mesh === undefined
      ? 'DEPLOYMENT_MESH_AUTO'
      : opts.enable_mesh
        ? 'DEPLOYMENT_MESH_ENABLED'
        : 'DEPLOYMENT_MESH_DISABLED';

  const idle_timeout = opts.idle_timeout ?? DEFAULT_IDLE_TIMEOUT;

  if (idle_timeout > 0) {
    let sleep_idle_delay: koyeb.DeploymentScalingTargetSleepIdleDelay;

    if (opts._experimental_enable_light_sleep) {
      sleep_idle_delay = { light_sleep_value: idle_timeout, deep_sleep_value: opts._experimental_deep_sleep_value ?? 3900 };
    } else {
      sleep_idle_delay = { deep_sleep_value: idle_timeout };
    }

    definition.scalings = [{ min: 0, max: 1, targets: [{ sleep_idle_delay }] }];
  } else {
    definition.scalings = [{ min: 1, max: 1 }];
  }

  if (opts.enable_tcp_proxy) {
    definition.proxy_ports = [{ port: 3031, protocol: 'tcp' }];
  }

  return { definition, sandbox_secret };
}
