import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_INSTANCE_WAIT_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SNAPSHOT_WAIT_TIMEOUT,
  DEFAULT_WAIT_START_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  FAST_POLL_WINDOW,
  PORT_MAX,
  PORT_MIN,
} from './constants.js';
import {
  InvalidPortError,
  NoSandboxSecretError,
  SandboxApiError,
  SandboxDeploymentError,
  SandboxError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
  SidecarError,
  SidecarTimeoutError,
} from './errors.js';
import { SandboxFilesystem } from './sandbox-filesystem.js';
import { DeclarativeSnapshot, type TemplateOptions } from './declarative-snapshot.js';
import type { Snapshot, SnapshotOptions, SnapshotType } from './snapshot.js';
import { buildNetworkPolicy, keepMesh, normalizeMeshScope, type MeshScope } from './cidr.js';
import { resolveClient } from './credentials.js';
import { CommandRunner } from './command-runner.js';
import {
  ExecutorGateway,
  type FileListEntry,
  type FileStatEntry,
  type FilesArchivePutReply,
  type FilesPutContent,
  type FilesPutOptions,
  type FilesPutReply,
  type FilesReadRangeReply,
  type FilesUploadCompleteReply,
  type FilesUploadSession,
  type FilesUploadStatus,
} from './executor-gateway.js';
import { buildDefinition, type ConfigFile, type EnvValue } from './definition.js';
import { type Duration, parseDuration } from './duration.js';
import { assert, getEnv, isDefined, omitUndefined } from './prelude.js';
import { classifyDeploymentStatus } from './readiness.js';
import { wait, waitFor, waitForPhased } from './time.js';
import {
  EGRESS_WITH_SIDECARS,
  INACTIVITY_WITH_SIDECARS,
  SIDECARS_ENV,
  Sidecar,
  SidecarInfo,
  alignedDeleteAfter,
  checkSidecarDeployment,
  matchSidecars,
  parseSidecarsEnv,
  prepareSidecars,
  sidecarsEnvValue,
} from './sidecar.js';
import { nanoId } from './id.js';

// Value types live with the definition module; re-exported for the public surface.
export type { ConfigFile, EnvValue, SecretRef } from './definition.js';

/**
 * The app holding a sandbox: unique even for two creates of the same name in the same millisecond (app names are
 * unique per organization), and no longer than the millisecond timestamp it replaced, so names that fit still fit.
 */
export function sandboxAppName(name: string | undefined) {
  return `sandbox-app-${name}-${Date.now().toString(36)}${randomAppSuffix(5)}`;
}

const randomAppSuffix = nanoId('0123456789abcdefghijklmnopqrstuvwxyz');

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What happened to the app after a failed create with sidecars: `undefined`
 *  means it was kept on purpose (Python: _app_outcome). */
function appOutcome(deleted: boolean | undefined, appId: string): string {
  if (deleted === undefined) {
    return `The sandbox was not created; app ${appId} was kept for inspection. Delete it when done.`;
  }

  if (deleted) {
    return 'The sandbox was not created and its app was deleted.';
  }

  return `The sandbox was not created and app ${appId} could not be deleted: delete it, its sidecars keep running until then.`;
}

/** Append how a failed create's app ended up to the error's message (Python: _with_outcome). */
function withOutcome(error: unknown, outcome: string): void {
  if (error instanceof Error) {
    error.message = error.message ? `${error.message} ${outcome}` : outcome;
  }
}

/** True when the sidecar is healthy, false while starting or after a transient
 *  API error (retried until the deadline); SidecarError when it never will be
 *  (Python: _sidecar_ready). */
async function sidecarReady(api: KoyebApi, info: SidecarInfo): Promise<boolean> {
  let status: koyeb.DeploymentStatus | undefined;

  try {
    const deploymentId = (await api.getService(info.service_id)).latest_deployment_id;

    if (!deploymentId) {
      return false;
    }

    status = (await api.getDeployment(deploymentId)).status;
  } catch {
    // A control-plane blip means "not yet".
    return false;
  }

  return checkSidecarDeployment(info, status);
}

/** SidecarTimeoutError naming the sidecars that never became healthy (Python: _sidecar_timeout_error). */
function sidecarTimeoutError(pending: SidecarInfo[], timeout: number): SidecarTimeoutError {
  const names = pending.map(({ name }) => `'${name}'`).join(', ');
  return new SidecarTimeoutError(
    pending.map(({ name }) => name).join(', '),
    timeout,
    `Sidecar ${names} did not become healthy within ${Math.round(timeout)} seconds (its first port must accept TCP connections; raise timeout or the sidecar's startup_grace_period for slow images)`,
  );
}

/** Wait until every sidecar deployment is healthy; SidecarError when one failed,
 *  SidecarTimeoutError at the deadline (Python: _wait_sidecars). */
async function waitSidecars(
  api: KoyebApi,
  infos: SidecarInfo[],
  timeout: number,
  pollInterval: number,
): Promise<void> {
  const start = Date.now();
  let pending = [...infos];
  let interval = Math.min(DEFAULT_WAIT_START_INTERVAL, pollInterval);

  for (;;) {
    // Only the ones still pending, like the sandbox readiness wait.
    const stillPending: SidecarInfo[] = [];

    for (const info of pending) {
      if (!(await sidecarReady(api, info))) {
        stillPending.push(info);
      }
    }

    pending = stillPending;

    if (pending.length === 0) {
      return;
    }

    if (Date.now() - start >= timeout * 1_000) {
      throw sidecarTimeoutError(pending, timeout);
    }

    await wait(interval * 1_000);

    // Fast at first, then doubling up to pollInterval, like wait_ready.
    const elapsed = (Date.now() - start) / 1_000;
    interval =
      elapsed < FAST_POLL_WINDOW
        ? Math.min(DEFAULT_WAIT_START_INTERVAL, pollInterval)
        : Math.min(interval * 2, pollInterval);
  }
}

/** Every WEB service of an app (paginated). Names are matched exactly by
 *  the caller: the API's name filter is a substring match (Python:
 *  _list_app_services). */
async function listAppServices(api: KoyebApi, appId: string): Promise<koyeb.Service[]> {
  const services: koyeb.Service[] = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const page = await api.listServicesPage({
      app_id: appId,
      types: ['WEB' as const],
      limit: String(limit),
      offset: String(offset),
    });
    services.push(...page.services);
    offset += limit;

    if (offset >= page.count || page.services.length === 0) {
      return services;
    }
  }
}

/** The sidecars a sandbox's KOYEB_SIDECARS env lists, matched by exact name to
 *  the services of the sandbox's app (Python: _find_sidecars).
 *
 *  Throws {@link SidecarError} when the env is damaged, the lookup fails, or a
 *  listed sidecar is missing: a partial list would make update_lifecycle
 *  skip sidecars silently. */
async function findSidecars(
  api: KoyebApi,
  service: Pick<koyeb.Service, 'app_id' | 'name'>,
  deploymentEnv?: readonly koyeb.DeploymentEnv[],
): Promise<SidecarInfo[]> {
  const entries = parseSidecarsEnv(deploymentEnv?.find(({ key }) => key === SIDECARS_ENV)?.value);

  if (entries.length === 0) {
    return [];
  }

  let services: koyeb.Service[];
  try {
    services = await listAppServices(api, service.app_id ?? '');
  } catch (error) {
    throw new SidecarError(`Could not look up the sidecars of sandbox '${service.name}': ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const { infos, missing } = matchSidecars(entries, services);

  if (missing.length > 0) {
    const names = missing.map((name) => `'${name}'`).join(', ');
    throw new SidecarError(
      `Sandbox '${service.name}' lists sidecar ${names} but its app has no such service (deleted?)`,
    );
  }

  return infos;
}

/** True when a deployment definition carries KOYEB_SIDECARS (Python:
 *  _lists_sidecars). */
function listsSidecars(definition?: koyeb.DeploymentDefinition): boolean {
  return (definition?.env ?? []).some(({ key, value }) => key === SIDECARS_ENV && value);
}

export type CreateSandboxOptions = Partial<{
  image: string;
  name: string;
  wait_ready: boolean;
  instance_type: string;
  exposed_port_protocol: 'http' | 'http2';
  env: Record<string, EnvValue>;
  config_files: Record<string, EnvValue | ConfigFile>;
  region: string;
  api_token: string;
  timeout: number;
  idle_timeout: number;
  enable_tcp_proxy: boolean;
  privileged: boolean;
  registry_secret?: string;
  delete_after_delay?: Duration;
  delete_after_inactivity_delay?: Duration;
  _experimental_enable_light_sleep: boolean;
  _experimental_deep_sleep_value: number;
  /** If true, block all outbound network access from the sandbox. Mutually exclusive with `outbound_allowlist`. */
  block_network: boolean;
  /**
   * IPs/CIDRs allowed as outbound destinations; all other outbound traffic is blocked. Bare IPs are
   * normalized to /32 (IPv4) or /128 (IPv6). An empty list blocks everything. Mutually exclusive with
   * `block_network`.
   */
  outbound_allowlist: string[];
  /** Create the sandbox service inside an existing app instead of a new one (Python-SDK parity). */
  app_id: string;
  /** Override the image entrypoint (Python-SDK parity). */
  entrypoint: string[];
  /** Override the image command (Python-SDK parity). */
  command: string;
  /** Arguments passed to the command (Python-SDK parity). */
  args: string[];
  /** Tri-state mesh toggle: unset = platform default, true = ENABLED, false = DISABLED (Python-SDK parity). */
  enable_mesh: boolean;
  /**
   * Which services share the sandbox's mesh: MESH_SCOPE_APP, MESH_SCOPE_WORKSPACE or
   * MESH_SCOPE_ORGANIZATION. Unset keeps the organization default. Setting a scope turns
   * the mesh on (`enable_mesh: false` is rejected). Not available on free instances or
   * with a full snapshot (Python-SDK parity).
   */
  mesh_scope: MeshScope | 'MESH_SCOPE_UNSPECIFIED';
  /** Target API host, overriding KOYEB_API_HOST (Python-SDK parity). */
  host: string;
  /** Use an explicit sandbox secret instead of generating one (Python-SDK parity). */
  sandbox_secret: string;
  /** Boot the sandbox from a snapshot (object, or name/ID string) instead of a plain image. */
  snapshot?: Snapshot | string;
  /** Poll interval in seconds for the readiness wait (Python-SDK parity). */
  poll_interval: number;
  /** Best-effort delete when readiness fails (default true; Python-SDK parity). */
  cleanup_on_failure: boolean;
  /**
   * Trusted helper services to run next to the sandbox, reached from it at
   * `http://<name>:<port>` over a private app-scoped mesh. They are created
   * first and, when `wait_ready` is on, the sandbox is created once they are
   * healthy. They share the sandbox's app (deleted with it) and its region and
   * delete delays. Can't be combined with `app_id`, `snapshot`, `block_network`,
   * `outbound_allowlist` or `enable_mesh: false` (Python-SDK parity).
   */
  sidecars?: Sidecar[];
}>;

// Command execution lives in the runner module; re-exported for the public surface.
export type { ExecOptions, ExecResult, SandboxExec } from './command-runner.js';
import type { ExecOptions, ExecResult, SandboxExec } from './command-runner.js';

export type SandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  /** OS process id, only while running (Python: ProcessInfo.pid). */
  pid?: number;
  /** Exit code, only once completed (Python: ProcessInfo.exit_code). */
  exit_code?: number;
  /** ISO 8601 timestamp of the start (Python: ProcessInfo.started_at). */
  started_at?: string;
  /** ISO 8601 timestamp of the completion, when applicable (Python: ProcessInfo.completed_at). */
  completed_at?: string;
};

export type SandboxProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

/** A process as the executor sends it: optional fields may be absent or null. */
type RawSandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  pid?: number | null;
  exit_code?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type ConnectionInfo = {
  public_url: string;
  routing_key?: string;
  secret: string;
};

export class Sandbox {
  private readonly api: KoyebApi;
  private _conn_info?: ConnectionInfo;
  private _domain?: string;
  // Pinned deployment (set on reconnection and network-policy updates) so
  // readiness polls the replacement, not the still-active old deployment.
  private _deployment_id?: string;
  private _sidecars: SidecarInfo[] = [];

  constructor(
    public readonly app_id: string,
    public readonly service_id: string,
    public readonly name: string,
    private readonly sandbox_secret?: string,
    private readonly api_token?: string,
    private readonly host?: string,
    /** False for sandboxes in caller-owned apps: delete() must not destroy the app. */
    private readonly owns_app = true,
    private readonly poll_interval: number = DEFAULT_POLL_INTERVAL,
  ) {
    this.api = new KoyebApi(this.api_token, undefined, this.host);
    // Transport policy rides on this class's authorized fetch, so the seam
    // tests already mock stays the seam.
    this.gateway = new ExecutorGateway((path, init, body) => this.fetch(path, init, body), { name: this.name });
    this.runner = new CommandRunner({
      name: this.name,
      post: (path, init, body, hooks, options) => this.request(path, init, body, hooks, options),
      raw: (path, init, body, options) => this.gateway.raw(path, init, body, options),
    });
  }

  private readonly gateway: ExecutorGateway;
  private readonly runner: CommandRunner;

  get id(): string {
    return this.service_id;
  }

  /** Sidecars created with this sandbox (a copy; empty without sidecars). */
  get sidecars(): SidecarInfo[] {
    return [...this._sidecars];
  }

  /**
   * The sidecar called `name`.
   *
   * @throws {SidecarError} If this sandbox has no sidecar with that name
   */
  sidecar(name: string): SidecarInfo {
    const info = this._sidecars.find((sidecar) => sidecar.name === name);

    if (!info) {
      throw new SidecarError(`Sandbox '${this.name}' has no sidecar '${name}'`);
    }

    return info;
  }

  private static defaultCreateSandboxOptions = {
    image: 'koyeb/sandbox',
    name: 'quick-sandbox',
    wait_ready: true,
    instance_type: 'micro',
    exposed_port_protocol: 'http',
    timeout: DEFAULT_WAIT_TIMEOUT,
    idle_timeout: DEFAULT_IDLE_TIMEOUT,
    cleanup_on_failure: true,
  } satisfies CreateSandboxOptions;

  static async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const opts = { ...this.defaultCreateSandboxOptions, ...omitUndefined(options) };
    const { token } = resolveClient(opts);

    // Sidecar conflicts fail before any API call; with sidecars, the mesh is
    // forced on with app scope, private to the sandbox and its sidecars.
    const sidecars = prepareSidecars(opts.sidecars, opts);

    if (sidecars) {
      opts.enable_mesh = true;
      opts.mesh_scope = 'MESH_SCOPE_APP';
      // Names and ports, as JSON: nothing secret. Code inside the sandbox can
      // read it, and get_from_id uses it to find the sidecars again.
      opts.env = { ...opts.env, [SIDECARS_ENV]: sidecarsEnvValue(sidecars) };
    }

    const { definition, sandbox_secret } = buildDefinition({
      name: opts.name,
      image: opts.image,
      instance_type: opts.instance_type,
      region: opts.region,
      env: opts.env,
      config_files: opts.config_files,
      privileged: opts.privileged,
      registry_secret: opts.registry_secret,
      exposed_port_protocol: opts.exposed_port_protocol,
      enable_tcp_proxy: opts.enable_tcp_proxy,
      idle_timeout: opts.idle_timeout,
      _experimental_enable_light_sleep: opts._experimental_enable_light_sleep,
      _experimental_deep_sleep_value: opts._experimental_deep_sleep_value,
      block_network: opts.block_network,
      outbound_allowlist: opts.outbound_allowlist,
      entrypoint: opts.entrypoint,
      command: opts.command,
      args: opts.args,
      enable_mesh: opts.enable_mesh,
      mesh_scope: opts.mesh_scope,
      sandbox_secret: opts.sandbox_secret,
    });

    const resolvedSnapshot =
      opts.snapshot !== undefined
        ? // Deferred: the snapshot module composes Sandbox, so resolve at call time.
          await (await import('./snapshot.js')).resolveSnapshot(opts.snapshot, token, opts.host)
        : undefined;

    if (resolvedSnapshot?.type === 'FULL' && normalizeMeshScope(opts.mesh_scope) !== undefined) {
      // A FULL snapshot carries its own definition; the scope would be silently dropped.
      throw new Error("mesh_scope can't be combined with a full snapshot");
    }
    // One deadline covers the whole create: the sidecar wait and the sandbox
    // readiness wait share it, so `timeout` bounds the total.
    const deadline = Date.now() + opts.timeout * 1_000;
    const { service, sidecars: sidecar_infos } = await this.createService(
      token,
      opts,
      definition,
      resolvedSnapshot,
      sidecars,
    );
    const sandbox = new Sandbox(
      service.app_id!,
      service.id!,
      service.name!,
      sandbox_secret,
      token,
      opts.host,
      !opts.app_id,
      opts.poll_interval,
    );
    sandbox._sidecars = sidecar_infos;

    if (sidecar_infos.length > 0) {
      const delay = parseDuration(opts.delete_after_delay);

      // Sidecars were created first and the platform counts the delay from
      // each service's own creation: extend theirs to the sandbox's (best
      // effort — a failure only logs).
      if (delay) {
        await sandbox.alignSidecarsAfterCreate(delay);
      }
    }

    // The create reply names the deployment it started: pin it so the
    // readiness wait never re-fetches the service to find it.
    if (service.latest_deployment_id) {
      sandbox.pinDeployment(service.latest_deployment_id);
    }

    if (opts.wait_ready) {
      // Cleanup never masks the original failure: delete errors are swallowed
      // and the readiness outcome (error or timeout note) is rethrown.
      const cleanup = () =>
        opts.cleanup_on_failure
          ? sandbox
              .delete()
              .then(
                () => true,
                () => false, // best-effort teardown; the original failure matters more
              )
          : Promise.resolve(false);

      let ready: boolean;
      try {
        // Sidecars created and waited for first: whatever time they took
        // comes off this wait's budget, not on top of it.
        ready = await sandbox.wait_ready(
          sidecars ? Math.max(1, (deadline - Date.now()) / 1_000) : opts.timeout,
          opts.poll_interval,
        );
      } catch (error) {
        const deleted = await cleanup();

        if (opts.cleanup_on_failure && error instanceof Error) {
          error.message += deleted
            ? ' The sandbox was deleted.'
            : ' The sandbox could not be deleted and may still exist.';
        }
        throw error;
      }
      if (!ready) {
        const deleted = await cleanup();

        if (!opts.cleanup_on_failure) {
          throw new SandboxTimeoutError(sandbox.name, opts.timeout);
        }
        throw new SandboxTimeoutError(
          sandbox.name,
          opts.timeout,
          `Sandbox '${sandbox.name}' did not become ready within ${opts.timeout} seconds ${
            deleted ? 'and was deleted' : 'but could not be deleted and may still exist'
          }. Create with cleanup_on_failure=False to keep a timed-out sandbox for inspection.`,
        );
      }
    }

    return sandbox;
  }

  /**
   * Create the sandbox service (and its sidecars) in the sandbox's app.
   *
   * With sidecars, they are created first in the same app and, when
   * `opts.wait_ready` is on, the sandbox is created once they are healthy.
   */
  private static async createService(
    token: string,
    opts: CreateSandboxOptions,
    definition: koyeb.DeploymentDefinition,
    snapshot?: { id: string; type: SnapshotType },
    sidecars: Sidecar[] = [],
  ): Promise<{ service: koyeb.Service; sidecars: SidecarInfo[] }> {
    const api = new KoyebApi(token, undefined, opts.host);

    let app: { id?: string };
    let created_app = false;

    if (opts.app_id) {
      app = { id: opts.app_id };
    } else {
      app = await api.createApp({
        name: sandboxAppName(opts.name),
        life_cycle: { delete_when_empty: true },
      });
      created_app = true;
    }

    // Only clean up apps we created; a caller-supplied app outlives us. The
    // cleanup must never mask the original failure. Returns whether the app
    // is gone.
    const delete_created_app = async (): Promise<boolean> => {
      if (!created_app) {
        return true;
      }

      try {
        await api.deleteApp(app.id!);
        return true;
      } catch {
        // best-effort teardown; the create error matters more
        return false;
      }
    };

    const sidecar_infos: SidecarInfo[] = [];

    if (sidecars.length > 0) {
      try {
        for (const sidecar of sidecars) {
          try {
            const service = await api.createService({
              app_id: app.id,
              // The API falls back to definition.name; the Python SDK's
              // CreateService payload sets the service name.
              name: sidecar.name,
              // Region and delete_after_delay follow the sandbox, so the
              // sidecar expires with it.
              definition: sidecar.definition(opts.region),
              life_cycle: {
                delete_after_create: parseDuration(opts.delete_after_delay),
                // Sidecars never sleep, so only delete_after_create applies.
                delete_after_sleep: 0,
              },
            });
            sidecar_infos.push(new SidecarInfo(sidecar.name, service.id!, sidecar.ports));
          } catch (error) {
            throw new SidecarError(`Failed to create sidecar '${sidecar.name}': ${errorMessage(error)}`, {
              cause: error,
            });
          }
        }

        if (opts.wait_ready) {
          await waitSidecars(
            api,
            sidecar_infos,
            opts.timeout ?? DEFAULT_WAIT_TIMEOUT,
            opts.poll_interval ?? DEFAULT_POLL_INTERVAL,
          );
        }
      } catch (error) {
        // A sidecar that ran and failed may be worth inspecting; anything
        // else cleans up.
        const keep = error instanceof SidecarError && !opts.cleanup_on_failure;
        const deleted = keep ? undefined : await delete_created_app();
        withOutcome(error, appOutcome(deleted, app.id!));
        throw error;
      }
    }

    try {
      const service = await api.createService({
        app_id: app.id,
        // A FULL snapshot carries its own definition; the API infers it.
        ...(snapshot ? { instance_snapshot_id: snapshot.id } : {}),
        ...(snapshot?.type === 'FULL' ? {} : { definition }),
        life_cycle: {
          delete_after_create: parseDuration(opts.delete_after_delay),
          delete_after_sleep: parseDuration(opts.delete_after_inactivity_delay),
        },
      });
      return { service, sidecars: sidecar_infos };
    } catch (error) {
      const deleted = await delete_created_app();

      if (sidecars.length === 0) {
        throw error;
      }

      const failure =
        error instanceof SandboxApiError
          ? new SandboxError(`Failed to create sandbox '${opts.name}': ${error.message}`, { cause: error })
          : error;
      withOutcome(failure, appOutcome(deleted, app.id!));
      throw failure;
    }
  }

  /**
   * List every sandbox service as lazy handles (Python parity).
   *
   * Handles carry no executor secret: connected operations raise
   * NoSandboxSecretError — reconnect with `Sandbox.get_from_id(handle.id)`.
   */
  static async list(
    options: { app_id?: string; name?: string; api_token?: string; host?: string } = {},
  ): Promise<Sandbox[]> {
    const { token, client: api } = resolveClient(options);

    const sandboxes: Sandbox[] = [];
    const limit = 100;
    let offset = 0;

    // Paginate until offset passes the reported total, mirroring the Python page size.
    for (;;) {
      const { services, count } = await api.listServicesPage(
        omitUndefined({
          app_id: options.app_id,
          name: options.name,
          types: ['SANDBOX' as const],
          limit: String(limit),
          offset: String(offset),
        }),
      );

      for (const service of services) {
        sandboxes.push(
          new Sandbox(service.app_id ?? '', service.id ?? '', service.name ?? '', undefined, token, options.host),
        );
      }

      offset += limit;

      if (offset >= count) {
        return sandboxes;
      }
    }
  }

  /** The pinned deployment id, or the live service's active/latest when unset. */
  private async resolveDeploymentId(): Promise<string | undefined> {
    if (isDefined(this._deployment_id)) {
      return this._deployment_id;
    }

    const service = await this.api.getService(this.service_id);
    // `||`, not `??`: the API sends an unset active deployment as "".
    const deploymentId = service.active_deployment_id || service.latest_deployment_id;

    if (deploymentId) {
      this._deployment_id = deploymentId;
    }

    return deploymentId;
  }

  private pinDeployment(deploymentId: string): void {
    this._deployment_id = deploymentId;
  }

  /** Seed the executor address from a deployment already in hand. */
  private seedConnInfoFromDeployment(deployment: koyeb.Deployment): void {
    if (this._conn_info) {
      return;
    }

    const sandbox = (deployment.metadata as koyeb.DeploymentMetadata | undefined)?.sandbox;

    if (sandbox?.public_url && sandbox?.routing_key && this.sandbox_secret) {
      this._conn_info = {
        public_url: `${sandbox.public_url}/koyeb-sandbox`,
        routing_key: sandbox.routing_key,
        secret: this.sandbox_secret,
      };
    }
  }

  /** Drop cached connection state after a redeployment, pinning the new deployment. */
  private resetConnectionState(deploymentId?: string): void {
    this._deployment_id = deploymentId;
    this._conn_info = undefined;
    this._domain = undefined;
  }

  static async get_from_id(serviceId: string, apiToken?: string, host?: string) {
    const { token, client: api } = resolveClient({ api_token: apiToken, host });
    const service = await api.getService(serviceId);
    // Prefer the live deployment over the latest one, matching the Python
    // SDK: a rolled-back sandbox must resolve to the deployment that is
    // actually serving. `||`, not `??`: the API sends an unset active
    // deployment as "" until the service has marked a deployment active,
    // a moment after it turns healthy.
    const deploymentId = service.active_deployment_id || service.latest_deployment_id;
    const noSecret = () =>
      new NoSandboxSecretError(
        `Sandbox '${serviceId}' has no SANDBOX_SECRET in its deployment definition — it may not be a Koyeb sandbox service, so the executor connection cannot be established.`,
      );

    if (!deploymentId) {
      throw noSecret();
    }

    const deployment = await api.getDeployment(deploymentId);

    const secret = deployment.definition?.env?.find(({ key }) => key === 'SANDBOX_SECRET');

    assert(secret?.value, noSecret());

    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, secret.value, token, host);
    // Reconnected handles poll the deployment they resolved, even if the
    // service later rolls to another one.
    sandbox.pinDeployment(deploymentId);
    // The deployment is in hand with its metadata: seed the executor
    // address so the first connected call needs no extra lookup.
    sandbox.seedConnInfoFromDeployment(deployment);
    // Re-find the sidecars the deployment's KOYEB_SIDECARS lists; raises
    // rather than returning a partial list.
    sandbox._sidecars = await findSidecars(api, service, deployment.definition?.env);

    return sandbox;
  }

  async wait_ready(
    timeout = DEFAULT_INSTANCE_WAIT_TIMEOUT,
    pollInterval = this.poll_interval,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Python latches deployment health: the phased wait advances from the
    // deployment phase to the executor phase on first success, then only
    // polls the executor for the rest of the wait.
    return waitForPhased(
      [() => this.deployment_healthy(), () => this.executor_healthy()],
      timeout,
      pollInterval,
      signal,
      DEFAULT_WAIT_START_INTERVAL,
      FAST_POLL_WINDOW,
    );
  }

  async wait_tcp_proxy_ready(
    timeout = DEFAULT_INSTANCE_WAIT_TIMEOUT,
    pollInterval = this.poll_interval,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitFor(
      async () => isDefined(await this.get_tcp_proxy_info()),
      timeout,
      pollInterval,
      signal,
      DEFAULT_WAIT_START_INTERVAL,
    );
  }

  async is_healthy(): Promise<boolean> {
    // Deployment status first (Python parity): a terminal deployment never
    // becomes ready, and transient errors just mean "not yet".
    if (!(await this.deployment_healthy())) {
      return false;
    }

    return this.executor_healthy();
  }

  private async deployment_healthy(): Promise<boolean> {
    try {
      const deploymentId = await this.resolveDeploymentId();

      if (!deploymentId) {
        return false;
      }

      const deployment = await this.api.getDeployment(deploymentId);

      if (classifyDeploymentStatus(deployment.status) === 'terminal_failure') {
        throw new SandboxDeploymentError(this.name, deployment.status ?? ('UNKNOWN' as koyeb.DeploymentStatus));
      }

      if (classifyDeploymentStatus(deployment.status) === 'ready') {
        // The healthy deployment publishes the executor address: seed it
        // so the executor phase needs no extra lookup.
        this.seedConnInfoFromDeployment(deployment);
        return true;
      }

      return false;
    } catch (error) {
      // Only the terminal-state signal matters; anything else keeps polling.
      if (error instanceof SandboxDeploymentError) {
        throw error;
      }
      return false;
    }
  }

  private async executor_healthy(): Promise<boolean> {
    // Through the transport seam like every other executor call: one header
    // assembly, and the 5s bound lives in the gateway (Python parity).
    return this.gateway.health();
  }

  async get_tcp_proxy_info(): Promise<[host: string, public_port: number] | undefined> {
    // Readiness polls this: a control-plane blip means "not yet", not an error.
    try {
      const service = await this.api.getService(this.service_id);

      if (!service.active_deployment_id) {
        return;
      }

      const deployment = await this.api.getDeployment(service.active_deployment_id);
      const proxy_port = deployment.metadata?.proxy_ports?.find(({ port }) => port === 3031);

      if (!proxy_port) {
        return;
      }

      return [proxy_port.host!, proxy_port.public_port!];
    } catch {
      return;
    }
  }

  private async get_domain_from_app(): Promise<string> {
    const app = await this.api.getApp(this.app_id);
    const domain = app.domains?.[0];

    assert(domain?.name, new SandboxError('Sandbox URL is not available (the sandbox may no longer exist)'));

    return domain.name;
  }

  async get_domain(): Promise<string> {
    if (this._domain) {
      return this._domain;
    }

    const metadata = await this.get_metadata_connection_info();

    if (metadata) {
      const raw = metadata.public_url;
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/r/${metadata.routing_key}/`;
      this._domain = url.toString();
      return this._domain;
    }

    this._domain = await this.get_domain_from_app();
    this._domain = `https://${this._domain}`;
    return this._domain;
  }

  private async get_metadata_connection_info(): Promise<{ public_url: string; routing_key: string } | undefined> {
    try {
      const deploymentId = await this.resolveDeploymentId();
      if (!deploymentId) return;

      const deployment = await this.api.getDeployment(deploymentId);
      const sandbox = (deployment.metadata as koyeb.DeploymentMetadata | undefined)?.sandbox;

      if (sandbox?.public_url && sandbox?.routing_key) {
        return { public_url: sandbox.public_url, routing_key: sandbox.routing_key };
      }
    } catch {
      return;
    }
  }

  async get_conn_info(): Promise<ConnectionInfo> {
    const conn_info = await this.resolve_conn_info();
    // Full override of the gateway the API advertises, like KOYEB_API_HOST
    // for the API (e.g. an in-cluster Service). Same as the Python SDK.
    const gateway_url = getEnv('KOYEB_SANDBOX_GATEWAY_URL');

    if (gateway_url) {
      return { ...conn_info, public_url: `${gateway_url.replace(/\/+$/, '')}/koyeb-sandbox` };
    }

    return conn_info;
  }

  private async resolve_conn_info(): Promise<ConnectionInfo> {
    if (this._conn_info) {
      return this._conn_info;
    }

    // Lazy handles (from list()) carry no executor secret; fail before any
    // request instead of calling the executor without credentials.
    assert(
      this.sandbox_secret,
      new NoSandboxSecretError(
        'Sandbox secret not available — this handle is not executor-connected (e.g. it came from Sandbox.list()); use Sandbox.get_from_id(<id>) for a connected handle',
      ),
    );

    const metadata = await this.get_metadata_connection_info();

    if (metadata) {
      this._conn_info = {
        public_url: `${metadata.public_url}/koyeb-sandbox`,
        routing_key: metadata.routing_key,
        secret: this.sandbox_secret,
      };
      return this._conn_info;
    }

    const domain = await this.get_domain_from_app();
    this._conn_info = {
      public_url: `https://${domain}/koyeb-sandbox`,
      secret: this.sandbox_secret,
    };
    return this._conn_info;
  }

  async get_sandbox_url(): Promise<string> {
    const conn_info = await this.get_conn_info();

    if (conn_info.routing_key) {
      return `${conn_info.public_url}/r/${conn_info.routing_key}`;
    }

    return conn_info.public_url;
  }

  /**
   * Update the sandbox's life cycle settings.
   *
   * Python parity: caller-supplied fields merge into the life cycle the service already
   * has — fields the call leaves out keep their current value instead of being cleared.
   *
   * With sidecars, the sidecars are updated first, so they expire with the sandbox
   * (without redeploying them), and `delete_after_inactivity_delay` is rejected: sidecars
   * never sleep, so they would outlive the sandbox. The sidecars are read from the
   * sandbox's live deployment, so this also works on handles from `list()`.
   *
   * Like the Python SDK, the update redeploys the service; the replacement deployment is
   * pinned so a later wait_ready() follows it.
   */
  async update_lifecycle(values?: {
    delete_after_delay?: Duration;
    delete_after_inactivity_delay?: Duration;
  }): Promise<void> {
    const inactivity =
      values?.delete_after_inactivity_delay !== undefined
        ? parseDuration(values.delete_after_inactivity_delay)
        : undefined;

    if (this._sidecars.length > 0 && inactivity) {
      throw new SidecarError(INACTIVITY_WITH_SIDECARS);
    }

    const service = await this.api.getService(this.service_id);
    const deployment = await this.api.getDeployment(service.latest_deployment_id!);

    const sidecars = await this.lifecycleSidecars(deployment);

    if (sidecars.length > 0 && inactivity) {
      throw new SidecarError(INACTIVITY_WITH_SIDECARS);
    }

    if (sidecars.length > 0 && values?.delete_after_delay !== undefined) {
      // Sidecars first, so a failure below changes nothing on the sandbox.
      await this.updateSidecarsDeleteAfter(sidecars, parseDuration(values.delete_after_delay)!, service.created_at);
    }

    // Start from the current life cycle, then overwrite only the fields the caller supplied.
    const life_cycle = { ...service.life_cycle };
    if (values?.delete_after_delay !== undefined) {
      life_cycle.delete_after_create = parseDuration(values.delete_after_delay);
    }
    if (values?.delete_after_inactivity_delay !== undefined) {
      life_cycle.delete_after_sleep = parseDuration(values.delete_after_inactivity_delay);
    }

    const updated = await this.api.updateService(this.service_id, {
      definition: deployment.definition,
      life_cycle,
    });

    // The update redeploys: pin the replacement so wait_ready() polls it.
    // The lifecycle is already applied, so a failed id lookup must not
    // surface as an update failure.
    let newDeploymentId: string | undefined;

    try {
      newDeploymentId =
        updated?.latest_deployment_id ?? (await this.api.getService(this.service_id)).latest_deployment_id;
    } catch {
      // Readiness resolves the id fresh when no pin is set.
    }

    this.resetConnectionState(newDeploymentId);
  }

  /** Best effort: a failure only logs — the sidecars then expire a few
   *  seconds before the sandbox (Python: _align_sidecars_after_create). */
  private async alignSidecarsAfterCreate(delay: number): Promise<void> {
    try {
      const created = (await this.api.getService(this.service_id)).created_at;
      await this.updateSidecarsDeleteAfter(this._sidecars, delay, created);
    } catch (error) {
      console.warn(`Could not align sidecar expiry with the sandbox: ${errorMessage(error)}`);
    }
  }

  /** The sidecars to keep in step: the live deployment's KOYEB_SIDECARS,
   *  covering `list()` handles and stale ones (Python: _lifecycle_sidecars). */
  private async lifecycleSidecars(deployment: koyeb.Deployment): Promise<SidecarInfo[]> {
    if (!listsSidecars(deployment.definition)) {
      return [...this._sidecars];
    }

    const service = await this.api.getService(this.service_id);
    const sidecars = await findSidecars(this.api, service, deployment.definition?.env);
    this._sidecars = sidecars;
    return sidecars;
  }

  /** Set each sidecar's `delete_after_create` so it expires with the sandbox,
   *  as a life-cycle-only update. Skips sidecars already set: an update that
   *  changes nothing would redeploy them (Python: _update_sidecars_delete_after).
   *
   *  @throws {SidecarError} Listing the sidecars whose life cycle could not be
   *    updated — nothing was changed on the sandbox. */
  private async updateSidecarsDeleteAfter(
    sidecars: SidecarInfo[],
    delay: number,
    sandboxCreatedAt?: string,
  ): Promise<void> {
    const failed: string[] = [];

    for (const info of sidecars) {
      try {
        const current = await this.api.getService(info.service_id);
        const target = alignedDeleteAfter(delay, sandboxCreatedAt, current.created_at);

        if ((current.life_cycle?.delete_after_create ?? 0) === target) {
          continue;
        }

        await this.api.updateService(
          info.service_id,
          { life_cycle: { delete_after_create: target } },
          { update_mask: 'life_cycle.delete_after_create' },
        );
      } catch (error) {
        console.debug(`Sidecar '${info.name}' life cycle update failed: ${errorMessage(error)}`);
        failed.push(info.name);
      }
    }

    if (failed.length > 0) {
      const names = failed.map((name) => `'${name}'`).join(', ');
      throw new SidecarError(
        `Nothing was changed on the sandbox: the life cycle of sidecar ${names} could not be updated. Retry update_lifecycle.`,
      );
    }
  }

  /**
   * Update the sandbox's egress network policy.
   *
   * Warning: applying a new network policy triggers a redeployment of the sandbox service. The
   * sandbox is restarted and any in-memory or non-persisted state is lost. This method does not
   * wait for the redeployment to finish.
   *
   * With no arguments, the egress policy is reset to the platform default (unrestricted outbound
   * access). `block_network` and `outbound_allowlist` are mutually exclusive. With sidecars, both
   * are rejected — on the live deployment too, so a handle from `list()` can't cut a sandbox off
   * from its sidecars either.
   *
   * @throws {EgressPolicyError} If both `block_network` and `outbound_allowlist` are passed, or an
   *   allowlist entry is not a valid IP address or CIDR.
   */
  async update_network_policy(values?: { block_network?: boolean; outbound_allowlist?: string[] }): Promise<void> {
    // Egress also blocks the mesh: a sandbox with sidecars would be cut off
    // from them. Set egress on each Sidecar instead.
    if (this._sidecars.length > 0 && (values?.block_network || values?.outbound_allowlist !== undefined)) {
      throw new SidecarError(EGRESS_WITH_SIDECARS);
    }

    // Validate before any API call so invalid input fails fast.
    const network_policy = buildNetworkPolicy(values?.block_network, values?.outbound_allowlist) ?? {
      egress: { mode: 'EGRESS_POLICY_MODE_DEFAULT' },
    };

    try {
      const service = await this.api.getService(this.service_id);
      const deployment = await this.api.getDeployment(service.latest_deployment_id!);

      if ((values?.block_network || values?.outbound_allowlist !== undefined) && listsSidecars(deployment.definition)) {
        // Covers handles that don't know their sidecars (list()).
        throw new SidecarError(EGRESS_WITH_SIDECARS);
      }

      const updated = await this.api.updateService(this.service_id, {
        definition: {
          ...deployment.definition,
          network_policy: keepMesh(network_policy, deployment.definition?.network_policy),
        },
      });

      // Pin the replacement so wait_ready() polls it, not the still-active old
      // deployment. The policy is already applied, so a failed id lookup must
      // not surface as an update failure.
      let newDeploymentId: string | undefined;

      try {
        newDeploymentId =
          updated?.latest_deployment_id ?? (await this.api.getService(this.service_id)).latest_deployment_id;
      } catch {
        // Readiness resolves the id fresh when no pin is set.
      }

      this.resetConnectionState(newDeploymentId);
    } catch (error) {
      if (error instanceof SandboxError) {
        throw error;
      }
      throw new SandboxError(`Failed to update network policy: ${String(error)}`);
    }
  }

  async delete(): Promise<void> {
    // A caller-owned app hosts other services: only tear down our own (Python parity).
    if (this.owns_app) {
      await this.api.deleteApp(this.app_id);
    } else {
      await this.api.deleteService(this.service_id);
    }
  }

  /**
   * Snapshot this sandbox's first running instance. The captured state can
   * boot new sandboxes without re-provisioning (see `create_from_snapshot`).
   */
  async snapshot(name: string, options: SnapshotOptions = {}): Promise<Snapshot> {
    // Python wraps every failure of this operation in one message.
    try {
      return await this.createSnapshot(name, options);
    } catch (error) {
      throw new SandboxError(`Failed to create snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createSnapshot(name: string, options: SnapshotOptions): Promise<Snapshot> {
    const instances = await this.api.listInstances({
      service_id: this.service_id,
      statuses: ['HEALTHY', 'STARTING', 'ALLOCATING'],
      limit: '1',
    });
    const instance = instances[0];
    assert(instance?.id, new SandboxError(`No running instances found for service ${this.service_id}`));

    const model = await this.api.createInstanceSnapshot({
      instance_id: instance.id,
      name,
      type: options.snapshot_type === 'FULL' ? 'INSTANCE_SNAPSHOT_TYPE_FULL' : 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM',
    });
    assert(model?.id, new SandboxError('Failed to create snapshot: no snapshot returned from API'));

    const snapshot = (await import('./snapshot.js')).Snapshot.from_model(model, {
      api_token: this.api_token,
      host: this.host,
      sandbox_secret: this.sandbox_secret,
    });

    if (options.wait_available === false) {
      return snapshot;
    }

    const timeout = options.timeout ?? DEFAULT_SNAPSHOT_WAIT_TIMEOUT;
    const done = await waitFor(
      async () => {
        await snapshot.refresh();
        return snapshot.status === 'AVAILABLE' || snapshot.status === 'ERROR';
      },
      timeout,
      options.poll_interval ?? this.poll_interval,
    );

    if (!done) {
      throw new SandboxTimeoutError(name, timeout, `Snapshot did not become available within ${timeout} seconds`);
    }

    if (snapshot.status === 'ERROR') {
      throw new SandboxError(`Snapshot creation failed: ${snapshot.messages.join(', ')}`);
    }

    return snapshot;
  }

  /** Create a new sandbox booted from a snapshot (object, or name/ID string). */
  /** Create a new sandbox booted from a snapshot. Options are the full create options (Python's **create_kwargs). */
  static async create_from_snapshot(
    snapshot: Snapshot | string,
    name?: string,
    options: CreateSandboxOptions = {},
  ): Promise<Sandbox> {
    return Sandbox.create({ snapshot, ...(name !== undefined ? { name } : {}), ...options });
  }

  /** Build a snapshot from a declarative recipe (files, copies, commands). */
  static template(name: string, image: string, options: TemplateOptions = {}): DeclarativeSnapshot {
    return new DeclarativeSnapshot(name, image, options);
  }

  async fetch(path: string, init: RequestInit, requestBody?: unknown) {
    const conn = await this.get_conn_info();
    init.headers = new Headers(init.headers);

    init.headers.set('Authorization', `Bearer ${conn.secret}`);

    if (conn.routing_key) {
      init.headers.set('X-Routing-Key', conn.routing_key);
    }

    if (isDefined(requestBody)) {
      init.headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(requestBody);
    }

    return fetch(`${conn.public_url}${path}`, init);
  }

  async request(
    path: string,
    init: RequestInit,
    requestBody?: unknown,
    hooks?: { onAttempt?: () => void },
    options?: { timeout?: number },
  ) {
    return this.gateway.post(path, init, requestBody, hooks, options);
  }

  /** Whether this sandbox's executor serves the streamed /files routes (probed once per handle). */
  hasFilesRoutes(): Promise<boolean> {
    return this.gateway.hasFilesRoutes();
  }

  /** Stat a file on the streamed /files routes (executor v0.0.24+); with
   *  hash: 'sha256' the reply carries the file's digest. */
  filesStat(path: string, options?: { hash?: 'sha256'; signal?: AbortSignal }): Promise<FileStatEntry> {
    return this.gateway.filesStat(path, options);
  }

  /** Stream content to a file through PUT /files (executor v0.0.24+), one non-retrying request. */
  filesPut(path: string, content: FilesPutContent, options?: FilesPutOptions): Promise<FilesPutReply> {
    return this.gateway.filesPut(path, content, options);
  }

  /** Stream a file's bytes from GET /files (executor v0.0.24+), chunk by chunk. */
  filesRead(path: string, options?: { signal?: AbortSignal }): AsyncGenerator<Uint8Array, void, unknown> {
    return this.gateway.filesRead(path, options);
  }

  /** Stream a directory listing from GET /files/list (executor v0.0.24+),
   *  entry by entry — one JSON object per line, errors carried per entry. */
  filesList(
    path: string,
    options?: { recursive?: boolean; signal?: AbortSignal },
  ): AsyncGenerator<FileListEntry, void, unknown> {
    return this.gateway.filesList(path, options);
  }

  /** Stream a directory as a gzip'd tar from GET /files/archive
   *  (executor v0.0.24+), chunk by chunk. */
  filesArchiveGet(
    path: string,
    options?: { exclude?: string[]; signal?: AbortSignal },
  ): AsyncGenerator<Uint8Array, void, unknown> {
    return this.gateway.filesArchiveGet(path, options);
  }

  /** Extract a gzip'd tar into the directory at path (executor v0.0.24+). */
  filesArchivePut(
    path: string,
    content: FilesPutContent,
    options?: { signal?: AbortSignal },
  ): Promise<FilesArchivePutReply> {
    return this.gateway.filesArchivePut(path, content, options);
  }

  /** GET /files with the resume headers (executor v0.0.24+): the reply's
   *  status, strong ETag and idle-bounded body stream. */
  filesReadRange(
    path: string,
    options?: { range?: string; ifRange?: string; signal?: AbortSignal },
  ): Promise<FilesReadRangeReply> {
    return this.gateway.filesReadRange(path, options);
  }

  /** Open a multipart upload session (executor v0.0.24+). */
  filesUploadOpen(
    path: string,
    size: number,
    options?: { mode?: string; sha256?: string; signal?: AbortSignal },
  ): Promise<FilesUploadSession> {
    return this.gateway.filesUploadOpen(path, size, options);
  }

  /** Write one part at its offset (executor v0.0.24+); idempotent at the executor. */
  filesUploadPart(
    uploadId: string,
    offset: number,
    content: Uint8Array,
    options?: { sha256?: string; signal?: AbortSignal },
  ): Promise<void> {
    return this.gateway.filesUploadPart(uploadId, offset, content, options);
  }

  /** The ranges received so far for a live session (executor v0.0.24+). */
  filesUploadStatus(uploadId: string, options?: { signal?: AbortSignal }): Promise<FilesUploadStatus> {
    return this.gateway.filesUploadStatus(uploadId, options);
  }

  /** Check coverage and commit (executor v0.0.24+). */
  filesUploadComplete(uploadId: string, options?: { signal?: AbortSignal }): Promise<FilesUploadCompleteReply> {
    return this.gateway.filesUploadComplete(uploadId, options);
  }

  /** Abort a session and remove its temp file (executor v0.0.24+). */
  filesUploadAbort(uploadId: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this.gateway.filesUploadAbort(uploadId, options);
  }

  get filesystem() {
    return new SandboxFilesystem(this);
  }

  async exec(cmd: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.runner.run(cmd, options);
  }

  exec_stream(
    cmd: string,
    options: Pick<ExecOptions, 'cwd' | 'env' | 'signal' | 'timeout'> = {},
  ): SandboxExec {
    return this.runner.stream(cmd, options);
  }

  async expose_port(port: number): Promise<{ port: number; exposed_at: string }> {
    assert(port >= PORT_MIN && port <= PORT_MAX, new InvalidPortError(port));

    // Python parity: the pre-unbind is best-effort — a failure means nothing was bound yet.
    await this.unexpose_port().catch(() => {});
    this.checkExecutorResponse(
      await this.request('/bind_port', { method: 'POST' }, { port: String(port) }),
      `expose port ${port}`,
    );

    const domain = await this.get_domain();

    return {
      port,
      exposed_at: `${domain}`,
    };
  }

  async unexpose_port(port?: number) {
    if (isDefined(port)) {
      assert(port >= PORT_MIN && port <= PORT_MAX, new InvalidPortError(port));
    }

    const response = await this.request('/unbind_port', { method: 'POST' }, {
      port: isDefined(port) ? String(port) : undefined,
    });
    this.checkExecutorResponse(response, 'unexpose port');
  }

  async launch_process(cmd: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
    const response = await this.request('/start_process', { method: 'POST' }, { cmd, ...options });
    this.checkExecutorResponse(response, 'launch process');

    if (!response.id) {
      throw new SandboxError('Failed to launch process: no process ID returned');
    }

    return response.id;
  }

  async kill_process(processId: string): Promise<void> {
    this.checkExecutorResponse(
      await this.request(`/kill_process`, { method: 'POST' }, { id: processId }),
      `kill process ${processId}`,
    );
  }

  // The executor reports some failures as a 200 body carrying an error;
  // Python surfaces those the same way as HTTP failures.
  private checkExecutorResponse(response: unknown, operation: string): void {
    if (!response || typeof response !== 'object') {
      return;
    }

    const result = response as { error?: unknown; success?: unknown };

    if (result.error || result.success === false) {
      throw new SandboxError(`Failed to ${operation}: ${String(result.error ?? 'Unknown error')}`);
    }
  }

  async list_processes(): Promise<SandboxProcess[]> {
    const response = await this.request('/list_processes', { method: 'GET' });
    // Python maps raw entries into ProcessInfo; normalize so null reads as undefined.
    const processes: RawSandboxProcess[] = response.processes ?? [];

    return processes.map(({ pid, exit_code, started_at, completed_at, ...core }) => ({
      ...core,
      pid: pid ?? undefined,
      exit_code: exit_code ?? undefined,
      started_at: started_at ?? undefined,
      completed_at: completed_at ?? undefined,
    }));
  }

  async kill_all_processes(): Promise<number> {
    let count = 0;

    for (const process of await this.list_processes()) {
      if (process.status === 'running') {
        try {
          await this.kill_process(process.id);
          count++;
        } catch (error) {
          // Python parity: a failed kill must not stop the remaining ones.
          if (!(error instanceof SandboxError)) {
            throw error;
          }
        }
      }
    }

    return count;
  }
}

