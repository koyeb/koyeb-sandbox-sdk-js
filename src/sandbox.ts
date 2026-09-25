import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_EXECUTOR_RETRIES,
  DEFAULT_EXECUTOR_RETRY_DELAY_MS,
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_INSTANCE_WAIT_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SNAPSHOT_WAIT_TIMEOUT,
  DEFAULT_WAIT_START_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  PORT_MAX,
  PORT_MIN,
} from './constants.js';
import {
  InvalidPortError,
  MissingApiTokenError,
  NoSandboxSecretError,
  SandboxCommandError,
  SandboxDeploymentError,
  SandboxError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';
import { SandboxFilesystem } from './sandbox-filesystem.js';
import {
  DeclarativeSnapshot,
  resolveSnapshot,
  Snapshot,
  type SnapshotOptions,
  type SnapshotType,
  type TemplateOptions,
} from './snapshot.js';
import { handleServerSentEvents } from './server-sent-event.js';
import { TypedEventTarget } from './typed-event-target.js';
import {
  assert,
  buildConfigFiles,
  buildEnvVars,
  buildNetworkPolicy,
  Duration,
  getEnv,
  isDefined,
  isUndefined,
  omitUndefined,
  parseDuration,
  randomString,
  waitFor,
  wait,
  buildDefinition,
} from './utils.js';

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
}>;

export type SandboxExec = TypedEventTarget<{
  stdout: MessageEvent<{ stream: 'stdout'; data: string }>;
  stderr: MessageEvent<{ stream: 'stderr'; data: string }>;
  exit: MessageEvent<{ code?: number; error?: boolean | string }>;
  end: Event;
  error: MessageEvent<unknown>;
}>;

/** Result of a command run through {@link Sandbox.exec} (Python: CommandResult). */
export type ExecResult = { stdout: string; stderr: string; code: number };

/** Options shared by the buffered and streaming exec routes. */
type ExecRouteOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Command timeout in seconds, enforced on the executor request (Python parity). */
  timeout?: number;
  /** Streaming stdout callback; when set, stdout is no longer buffered (Python parity). */
  on_stdout?: (chunk: string) => void;
  /** Streaming stderr callback; when set, stderr is no longer buffered (Python parity). */
  on_stderr?: (chunk: string) => void;
  /** Consume the SSE stream (default) or buffer server-side via /run. */
  stream?: boolean;
  /** Raise SandboxCommandError on non-zero exit (default false, Python parity). */
  raise_on_error?: boolean;
  signal?: AbortSignal;
};

export type SandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  pid: string;
};

export type SandboxProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

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
  }

  get id(): string {
    return this.service_id;
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
    const token = opts.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
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
      sandbox_secret: opts.sandbox_secret,
    });

    const resolvedSnapshot =
      opts.snapshot !== undefined ? await resolveSnapshot(opts.snapshot, token, opts.host) : undefined;
    const service = await this.createService(token, opts, definition, resolvedSnapshot);
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
        ready = await sandbox.wait_ready(opts.timeout, opts.poll_interval);
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

  private static async createService(
    token: string,
    opts: CreateSandboxOptions,
    definition: koyeb.DeploymentDefinition,
    snapshot?: { id: string; type: SnapshotType },
  ) {
    const api = new KoyebApi(token, undefined, opts.host);

    let app: { id?: string };

    if (opts.app_id) {
      app = { id: opts.app_id };
    } else {
      app = await api.createApp({
        name: `sandbox-app-${opts.name}-${Date.now()}`,
        life_cycle: { delete_when_empty: true },
      });
    }

    try {
      return await api.createService({
        app_id: app.id,
        // A FULL snapshot carries its own definition; the API infers it.
        ...(snapshot ? { instance_snapshot_id: snapshot.id } : {}),
        ...(snapshot?.type === 'FULL' ? {} : { definition }),
        life_cycle: {
          delete_after_create: parseDuration(opts.delete_after_delay),
          delete_after_sleep: parseDuration(opts.delete_after_inactivity_delay),
        },
      });
    } catch (error) {
      // Only clean up apps we created; a caller-supplied app outlives us.
      // The cleanup must never mask the original create failure.
      if (!opts.app_id) {
        await api.deleteApp(app.id!).catch(() => {
          // best-effort teardown; the create error matters more
        });
      }
      throw error;
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
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const api = new KoyebApi(token, undefined, options.host);
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
    const deploymentId = service.active_deployment_id ?? service.latest_deployment_id;

    if (deploymentId) {
      this._deployment_id = deploymentId;
    }

    return deploymentId;
  }

  private pinDeployment(deploymentId: string): void {
    this._deployment_id = deploymentId;
  }

  /** Drop cached connection state after a redeployment, pinning the new deployment. */
  private resetConnectionState(deploymentId?: string): void {
    this._deployment_id = deploymentId;
    this._conn_info = undefined;
    this._domain = undefined;
  }

  static async get_from_id(serviceId: string, apiToken?: string, host?: string) {
    const token = apiToken ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const api = new KoyebApi(token, undefined, host);
    const service = await api.getService(serviceId);
    // Prefer the live deployment over the latest one, matching the Python
    // SDK: a rolled-back sandbox must resolve to the deployment that is
    // actually serving.
    const deploymentId = service.active_deployment_id ?? service.latest_deployment_id;
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

    return sandbox;
  }

  async wait_ready(
    timeout = DEFAULT_INSTANCE_WAIT_TIMEOUT,
    pollInterval = this.poll_interval,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Python latches deployment health: once the deployment is confirmed
    // healthy, only the executor is polled for the rest of the wait.
    const start = Date.now();
    let delay = Math.min(DEFAULT_WAIT_START_INTERVAL, pollInterval);
    let deploymentReady = false;

    while (Date.now() - start < timeout * 1_000) {
      if (signal?.aborted) {
        return false;
      }

      if (!deploymentReady) {
        deploymentReady = await this.deployment_healthy();

        if (!deploymentReady) {
          await wait(delay * 1_000, signal);
          delay = Math.min(pollInterval, delay * 2);
          continue;
        }
      }

      if (await this.executor_healthy()) {
        return true;
      }

      await wait(delay * 1_000, signal);
      delay = Math.min(pollInterval, delay * 2);
    }

    return false;
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
        throw new SandboxDeploymentError(this.name, deployment.status ?? 'UNKNOWN');
      }

      return classifyDeploymentStatus(deployment.status) === 'ready';
    } catch (error) {
      // Only the terminal-state signal matters; anything else keeps polling.
      if (error instanceof SandboxDeploymentError) {
        throw error;
      }
      return false;
    }
  }

  private async executor_healthy(): Promise<boolean> {
    try {
      const conn = await this.get_conn_info();
      const headers: Record<string, string> = { Authorization: `Bearer ${conn.secret}` };

      if (conn.routing_key) {
        headers['X-Routing-Key'] = conn.routing_key;
      }

      // Python bounds the health probe at 5s so a wedged executor cannot stall the wait.
      const response = await fetch(`${conn.public_url}/health`, { headers, signal: AbortSignal.timeout(5_000) });

      return response.ok;
    } catch {
      return false;
    }
  }

  async get_tcp_proxy_info(): Promise<[host: string, public_port: number] | undefined> {
    const service = await this.api.getService(this.service_id);

    if (isUndefined(service.active_deployment_id)) {
      return;
    }

    const deployment = await this.api.getDeployment(service.active_deployment_id);
    const proxy_port = deployment.metadata?.proxy_ports?.find(({ port }) => port === 3031);

    if (!proxy_port) {
      return;
    }

    return [proxy_port.host!, proxy_port.public_port!];
  }

  private async get_domain_from_app(): Promise<string> {
    const app = await this.api.getApp(this.app_id);
    const domain = app.domains?.[0];

    assert(domain?.name);

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

  async update_lifecycle(values?: {
    delete_after_delay?: Duration;
    delete_after_inactivity_delay?: Duration;
  }): Promise<void> {
    const service = await this.api.getService(this.service_id);
    const deployment = await this.api.getDeployment(service.latest_deployment_id!);

    await this.api.updateService(this.service_id, {
      definition: deployment.definition,
      life_cycle: {
        delete_after_create: parseDuration(values?.delete_after_delay),
        delete_after_sleep: parseDuration(values?.delete_after_inactivity_delay),
      },
    });
  }

  /**
   * Update the sandbox's egress network policy.
   *
   * Warning: applying a new network policy triggers a redeployment of the sandbox service. The
   * sandbox is restarted and any in-memory or non-persisted state is lost. This method does not
   * wait for the redeployment to finish.
   *
   * With no arguments, the egress policy is reset to the platform default (unrestricted outbound
   * access). `block_network` and `outbound_allowlist` are mutually exclusive.
   *
   * @throws {EgressPolicyError} If both `block_network` and `outbound_allowlist` are passed, or an
   *   allowlist entry is not a valid IP address or CIDR.
   */
  async update_network_policy(values?: { block_network?: boolean; outbound_allowlist?: string[] }): Promise<void> {
    // Validate before any API call so invalid input fails fast.
    const network_policy = buildNetworkPolicy(values?.block_network, values?.outbound_allowlist) ?? {
      egress: { mode: 'EGRESS_POLICY_MODE_DEFAULT' },
    };

    try {
      const service = await this.api.getService(this.service_id);
      const deployment = await this.api.getDeployment(service.latest_deployment_id!);

      const updated = await this.api.updateService(this.service_id, {
        definition: { ...deployment.definition, network_policy },
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

    const snapshot = Snapshot.from_model(model, {
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
  static async create_from_snapshot(
    snapshot: Snapshot | string,
    name?: string,
    options: Partial<{ wait_ready: boolean; timeout: number; api_token: string; host: string }> = {},
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

  async request(path: string, init: RequestInit, requestBody?: unknown, hooks?: { onAttempt?: () => void }) {
    // Transient executor unavailability (cold starts, restarts, 5xx, network
    // blips): retry with exponential backoff before failing (Python parity).
    let backoff = DEFAULT_EXECUTOR_RETRY_DELAY_MS;

    for (let attempt = 0; ; attempt++) {
      // Python re-arms the per-read timeout on every attempt.
      hooks?.onAttempt?.();

      let response: Response;

      try {
        response = await this.fetch(path, init, requestBody);
      } catch (error) {
        // Abort-driven failures are not transient; fail fast without retries.
        if (init.signal?.aborted) {
          throw error;
        }

        if (attempt >= DEFAULT_EXECUTOR_RETRIES) {
          throw error instanceof SandboxError
            ? error
            : new SandboxError(`Request to sandbox executor failed: ${String(error)}`);
        }

        await wait(backoff, init.signal ?? undefined);
        backoff *= 2;
        continue;
      }

      if (response.status >= 500 && attempt < DEFAULT_EXECUTOR_RETRIES) {
        // Free the connection before the retry and honor early aborts.
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        await wait(backoff, init.signal ?? undefined);
        backoff *= 2;
        continue;
      }

      const contentType = response.headers.get('Content-Type');
      const responseBody =
        contentType?.startsWith('application/json') ? await response.json() : await response.text();

      if (!response.ok) {
        if (response.status >= 500) {
          throw new SandboxServiceError(
            response.status,
            typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
          );
        }
        throw new SandboxRequestError(response.status, responseBody);
      }

      return responseBody;
    }
  }

  get filesystem() {
    return new SandboxFilesystem(this);
  }

  async exec(
    cmd: string,
    {
      cwd,
      env,
      timeout = DEFAULT_COMMAND_TIMEOUT,
      on_stdout,
      on_stderr,
      stream = true,
      raise_on_error = false,
      signal,
    }: ExecOptions = {},
  ): Promise<ExecResult> {
    const result = await (stream
      ? this.execStreaming(cmd, { cwd, env, timeout, on_stdout, on_stderr, signal })
      : this.execBuffered(cmd, { cwd, env, timeout, signal }));

    if (raise_on_error && result.code !== 0) {
      throw new SandboxCommandError({ command: cmd, ...result });
    }

    return result;
  }

  /** Buffered route: one POST to /run, carrying the retrying request machinery. */
  private async execBuffered(cmd: string, { cwd, env, timeout, signal }: ExecRouteOptions): Promise<ExecResult> {
    const deadline = new Deadline(timeout, signal);

    try {
      const reply = await this.request(
        '/run',
        { method: 'POST', signal: deadline.signal },
        { cmd, cwd, env },
        { onAttempt: () => deadline.arm() },
      );
      // Normalize like Python's response.get(...) so partial replies type-check.
      return { stdout: reply?.stdout ?? '', stderr: reply?.stderr ?? '', code: reply?.code ?? 0 };
    } catch (error) {
      throw deadline.mapFailure(error, this.name);
    } finally {
      deadline.dispose();
    }
  }

  /** Streaming route: reassembles the SSE events into a command result, like Python's exec. */
  private async execStreaming(
    cmd: string,
    {
      cwd,
      env,
      timeout,
      on_stdout,
      on_stderr,
      signal,
    }: ExecRouteOptions & Pick<ExecOptions, 'on_stdout' | 'on_stderr'>,
  ): Promise<ExecResult> {
    // Python parity: callbacks consume chunks live; output is only buffered when neither is set.
    const buffer = !on_stdout && !on_stderr;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    let startError: string | undefined;

    const consume = (callback: ((chunk: string) => void) | undefined, chunks: string[]) => (event: Event) => {
        const chunk = (event as MessageEvent<{ data: string }>).data.data;
        if (callback) callback(chunk);
        else if (buffer) chunks.push(chunk);
      };
    const emitter = new EventTarget();
    emitter.addEventListener('stdout', consume(on_stdout, stdout));
    emitter.addEventListener('stderr', consume(on_stderr, stderr));
    emitter.addEventListener('exit', (event) => {
      const data = (event as MessageEvent<{ code?: number; error?: boolean | string }>).data;
      // Python checks "code" before "error": an explicit code always wins.
      if (typeof data.code === 'number') {
        code = data.code;
      } else if (typeof data.error === 'string') {
        startError = data.error;
      }
    });

    const deadline = new Deadline(timeout, signal);

    try {
      const response = await this.fetch('/run_streaming', { method: 'POST', signal: deadline.signal }, { cmd, cwd, env });

      if (!response.ok) {
        const body = await response.text();
        if (response.status >= 500) {
          throw new SandboxServiceError(response.status, body);
        }
        throw new SandboxRequestError(response.status, body);
      }

      assert(response.body);
      await handleServerSentEvents(emitter, response.body, () => deadline.arm());
    } catch (error) {
      throw deadline.mapStreamFailure(error, this.name);
    } finally {
      deadline.dispose();
    }

    if (startError !== undefined) {
      // Python parity: a start failure discards partial output and exits 1.
      return { stdout: '', stderr: startError, code: 1 };
    }

    return { stdout: stdout.join(''), stderr: stderr.join(''), code };
  }

  exec_stream(cmd: string, { cwd, env, signal }: Pick<ExecOptions, 'cwd' | 'env' | 'signal'> = {}): SandboxExec {
    const emitter = new EventTarget();

    this.fetch('/run_streaming', { method: 'POST', signal }, { cmd, cwd, env })
      .then((response) => response.body)
      .then((body) => body && handleServerSentEvents(emitter, body))
      .catch((error) => emitter.dispatchEvent(new MessageEvent('error', { data: error })));

    return emitter;
  }

  async expose_port(port: number): Promise<{ port: number; exposed_at: string }> {
    assert(port >= PORT_MIN && port <= PORT_MAX, new InvalidPortError(port));

    await this.unexpose_port();
    await this.request('/bind_port', { method: 'POST' }, { port: String(port) });

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

    await this.request('/unbind_port', { method: 'POST' }, { port: isDefined(port) ? String(port) : undefined });
  }

  async launch_process(cmd: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
    const response = await this.request('/start_process', { method: 'POST' }, { cmd, ...options });
    return response.id;
  }

  async kill_process(processId: string): Promise<void> {
    await this.request(`/kill_process`, { method: 'POST' }, { id: processId });
  }

  async list_processes(): Promise<SandboxProcess[]> {
    const response = await this.request('/list_processes', { method: 'GET' });
    return response.processes;
  }

  async kill_all_processes(): Promise<number> {
    let count = 0;

    for (const process of await this.list_processes()) {
      if (process.status === 'running') {
        await this.kill_process(process.id);
        count++;
      }
    }

    return count;
  }
}

const DEPLOYMENT_READY_STATUSES: koyeb.DeploymentStatus[] = ['HEALTHY', 'DEGRADED'];
const DEPLOYMENT_IN_PROGRESS_STATUSES: koyeb.DeploymentStatus[] = [
  'PENDING',
  'PROVISIONING',
  'SCHEDULED',
  'ALLOCATING',
  'STARTING',
];

/**
 * Classify a deployment status for readiness, failing closed: everything
 * outside the ready and in-progress sets is terminal (Python parity).
 */
function classifyDeploymentStatus(status?: koyeb.DeploymentStatus) {
  if (status && DEPLOYMENT_READY_STATUSES.includes(status)) {
    return 'ready';
  }

  if (status && DEPLOYMENT_IN_PROGRESS_STATUSES.includes(status)) {
    return 'in_progress';
  }

  return 'terminal_failure';
}

/**
 * Command deadline mirroring httpx's read timeout: the timer re-arms on every
 * received chunk, so a command that keeps producing output never times out
 * while a silent one aborts after `timeout` seconds.
 */
class Deadline {
  private timer?: ReturnType<typeof setTimeout>;
  private fired = false;
  private readonly controller = new AbortController();
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(
    private readonly timeout: number,
    private readonly callerSignal?: AbortSignal,
  ) {
    if (callerSignal) {
      callerSignal.addEventListener('abort', this.onCallerAbort, { once: true });

      if (callerSignal.aborted) {
        this.controller.abort();
      }
    }

    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.timeout * 1_000);
    // A pending deadline must never keep the event loop alive.
    this.timer.unref?.();
  }

  /** Distinguish deadline aborts from caller aborts: only the former are timeouts. */
  mapFailure(error: unknown, sandboxName: string): unknown {
    if (this.fired) {
      return new SandboxTimeoutError(sandboxName, this.timeout, `Request timed out after ${this.timeout}s`);
    }
    return error;
  }

  /**
   * Streaming failures map to the SDK taxonomy: timeouts map, typed errors and
   * caller aborts pass through, lost connections become SandboxError like Python.
   */
  mapStreamFailure(error: unknown, sandboxName: string): unknown {
    if (this.fired) {
      return new SandboxTimeoutError(sandboxName, this.timeout, `Request timed out after ${this.timeout}s`);
    }

    if (error instanceof SandboxError || this.aborted) {
      return error;
    }

    return new SandboxError(`Connection to sandbox lost: ${String(error)}`);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener('abort', this.onCallerAbort);
  }
}
