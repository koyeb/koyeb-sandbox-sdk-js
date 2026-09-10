import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_CREATE_TIMEOUT,
  DEFAULT_HTTP_TIMEOUT,
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_RETRY_BACKOFF,
  DEFAULT_WAIT_TIMEOUT,
  PORT_MAX,
  PORT_MIN,
} from './constants.js';
import {
  InvalidPortError,
  MissingApiTokenError,
  NoSandboxSecretError,
  SandboxConnectionError,
  SandboxDeploymentError,
  SandboxError,
  SandboxRequestError,
  SandboxServiceError,
  SandboxTimeoutError,
} from './errors.js';
import { SandboxFilesystem } from './sandbox-filesystem.js';
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
  wait,
  waitFor,
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
  app_id: string;
  project_id: string;
  enable_mesh: boolean;
  entrypoint: string[];
  command: string;
  args: string[];
  snapshot: Snapshot | string;
  sandbox_secret: string;
  delete_after_delay?: Duration;
  delete_after_inactivity_delay?: Duration;
  _experimental_enable_light_sleep: boolean;
  /** If true, block all outbound network access from the sandbox. Mutually exclusive with `outbound_allowlist`. */
  block_network: boolean;
  /**
   * IPs/CIDRs allowed as outbound destinations; all other outbound traffic is blocked. Bare IPs are
   * normalized to /32 (IPv4) or /128 (IPv6). An empty list blocks everything. Mutually exclusive with
   * `block_network`.
   */
  outbound_allowlist: string[];
}>;

export type SandboxExec = TypedEventTarget<{
  stdout: MessageEvent<{ stream: 'stdout'; data: string }>;
  stderr: MessageEvent<{ stream: 'stderr'; data: string }>;
  exit: MessageEvent<{ code: number; error: boolean }>;
  end: Event;
  error: MessageEvent<Error>;
}>;

export type SandboxProcess = {
  id: string;
  command: string;
  status: SandboxProcessStatus;
  pid: string;
};

export type SandboxProcessStatus = 'running' | 'completed' | 'failed' | 'killed';

export const SnapshotType = {
  FILESYSTEM: 'filesystem',
  FULL: 'full',
} as const;

export type SnapshotType = (typeof SnapshotType)[keyof typeof SnapshotType];

export const SnapshotStatus = {
  INVALID: 'invalid',
  CREATING: 'creating',
  AVAILABLE: 'available',
  DELETING: 'deleting',
  DELETED: 'deleted',
  FAILED: 'failed',
} as const;

export type SnapshotStatus = (typeof SnapshotStatus)[keyof typeof SnapshotStatus];

export type DeclarativeSnapshotOptions = {
  workdir?: string;
  api_token?: string;
  delete_builder?: boolean;
  project_id?: string;
};

type ConnectionInfo = {
  public_url: string;
  routing_key?: string;
  secret: string;
};

type ExecutorRequestOptions = {
  timeout?: number;
  maxRetries?: number;
  initialBackoff?: number;
};

export class Sandbox {
  private readonly api: KoyebApi;
  private _conn_info?: ConnectionInfo;
  private _domain?: string;
  private _deployment_id?: string;

  constructor(
    public readonly app_id: string,
    public readonly service_id: string,
    public readonly name: string,
    private readonly sandbox_secret: string,
    private readonly api_token?: string,
    private readonly owns_app = true,
  ) {
    this.api = new KoyebApi(this.api_token);
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
    timeout: DEFAULT_CREATE_TIMEOUT,
    idle_timeout: DEFAULT_IDLE_TIMEOUT,
  } satisfies CreateSandboxOptions;

  static async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const opts = { ...this.defaultCreateSandboxOptions, ...omitUndefined(options) };
    const token = opts.api_token ?? getEnv('KOYEB_API_TOKEN');
    const region = opts.region || getEnv('KOYEB_REGION') || 'na';
    const projectId = opts.project_id || getEnv('KOYEB_PROJECT_ID') || undefined;

    if (!token) {
      throw new MissingApiTokenError();
    }

    // Validate egress arguments before any API call so invalid input fails fast.
    const network_policy = buildNetworkPolicy(opts.block_network, opts.outbound_allowlist);

    const snapshot = opts.snapshot;
    const snapshotId = typeof snapshot === 'string' ? snapshot : snapshot?.id;
    const snapshotType = typeof snapshot === 'string' ? SnapshotType.FILESYSTEM : snapshot?.snapshot_type;
    const sandbox_secret =
      opts.sandbox_secret ?? (typeof snapshot === 'string' ? undefined : snapshot?.sandbox_secret) ?? randomString(32);

    if (snapshotType === SnapshotType.FULL && snapshot && typeof snapshot !== 'string' && !snapshot.sandbox_secret) {
      throw new SandboxError('A full snapshot requires its original sandbox secret');
    }

    const definition: koyeb.DeploymentDefinition = {
      name: opts.name,
      type: 'SANDBOX',
      docker: {
        image: opts.image,
        privileged: opts.privileged,
        image_registry_secret: opts.registry_secret,
        entrypoint: opts.entrypoint,
        command: opts.command,
        args: opts.args,
      },
      instance_types: [{ type: opts.instance_type }],
      regions: [region],
      ports: [
        { port: 3030, protocol: 'http' },
        { port: 3031, protocol: opts.exposed_port_protocol },
      ],
      routes: [
        { port: 3030, path: '/koyeb-sandbox/' },
        { port: 3031, path: '/' },
      ],
    };

    if (isDefined(opts.enable_mesh)) {
      definition.mesh = opts.enable_mesh ? 'DEPLOYMENT_MESH_ENABLED' : 'DEPLOYMENT_MESH_DISABLED';
    }

    definition.env = [{ key: 'SANDBOX_SECRET', value: sandbox_secret }, ...buildEnvVars(opts.env)];

    const config_files = buildConfigFiles(opts.config_files);
    if (config_files.length > 0) {
      definition.config_files = config_files;
    }

    if (network_policy) {
      definition.network_policy = network_policy;
    }

    if (opts.idle_timeout > 0) {
      let sleep_idle_delay: koyeb.DeploymentScalingTargetSleepIdleDelay;

      if (opts._experimental_enable_light_sleep) {
        sleep_idle_delay = { light_sleep_value: opts.idle_timeout, deep_sleep_value: 3900 };
      } else {
        sleep_idle_delay = { deep_sleep_value: opts.idle_timeout };
      }

      definition.scalings = [{ min: 0, max: 1, targets: [{ sleep_idle_delay }] }];
    } else {
      definition.scalings = [{ min: 1, max: 1 }];
    }

    if (opts.enable_tcp_proxy) {
      definition.proxy_ports = [{ port: 3031, protocol: 'tcp' }];
    }

    const serviceDefinition = snapshotType === SnapshotType.FULL ? undefined : definition;
    const { service, ownsApp } = await this.createService(token, opts, projectId, serviceDefinition, snapshotId);
    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, sandbox_secret, token, ownsApp);

    if (opts.wait_ready) {
      let ready: boolean;
      try {
        ready = await sandbox.wait_ready(opts.timeout);
      } catch (error) {
        try {
          await sandbox.delete();
        } catch {
          // best-effort cleanup; suppress delete error to preserve original
        }
        throw error;
      }
      if (!ready) {
        try {
          await sandbox.delete();
        } catch {
          // best-effort cleanup; suppress delete error to preserve original
        }
        throw new SandboxTimeoutError(sandbox.name, opts.timeout);
      }
    }

    return sandbox;
  }

  private static async createService(
    token: string,
    opts: CreateSandboxOptions,
    projectId: string | undefined,
    definition: koyeb.DeploymentDefinition | undefined,
    snapshotId: string | undefined,
  ) {
    const api = new KoyebApi(token);

    if (definition) {
      await api.createService(
        { app_id: opts.app_id ?? '74140198-4d29-4a1e-bdc9-5cc2b355ccd0', definition, project_id: projectId },
        { dry_run: true },
      );
    }

    const ownsApp = !opts.app_id;
    const app = opts.app_id
      ? { id: opts.app_id }
      : await api.createApp({
          name: `sandbox-app-${opts.name}-${Date.now()}`,
          life_cycle: { delete_when_empty: true },
          project_id: projectId,
        });

    try {
      const service = await api.createService({
        app_id: app.id,
        definition,
        project_id: projectId,
        instance_snapshot_id: snapshotId,
        name: opts.name,
        life_cycle: {
          delete_after_create: parseDuration(opts.delete_after_delay),
          delete_after_sleep: parseDuration(opts.delete_after_inactivity_delay),
        },
      });
      return { service, ownsApp };
    } catch (error) {
      if (ownsApp) {
        await api.deleteApp(app.id!);
      }
      throw error;
    }
  }

  static async get_from_id(serviceId: string, apiToken?: string) {
    const token = apiToken ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const api = new KoyebApi(token);
    const service = await api.getService(serviceId);
    const deploymentId = service.active_deployment_id ?? service.latest_deployment_id;

    assert(deploymentId, new SandboxError(`Sandbox '${serviceId}' has no deployment`));

    const deployment = await api.getDeployment(deploymentId);

    const secret = deployment.definition?.env?.find(({ key }) => key === 'SANDBOX_SECRET');

    assert(secret?.value, new NoSandboxSecretError());

    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, secret.value, token);
    sandbox._deployment_id = deploymentId;

    const metadata = deployment.metadata?.sandbox;
    if (metadata?.public_url && metadata.routing_key) {
      sandbox._conn_info = {
        public_url: `${metadata.public_url}/koyeb-sandbox`,
        routing_key: metadata.routing_key,
        secret: secret.value,
      };
    }

    return sandbox;
  }

  static create_from_snapshot(snapshot: Snapshot | string, options: CreateSandboxOptions = {}): Promise<Sandbox> {
    return this.create({ ...options, snapshot });
  }

  static template(name: string, image: string, options: DeclarativeSnapshotOptions = {}): DeclarativeSnapshot {
    return new DeclarativeSnapshot(name, image, options);
  }

  async wait_ready(
    timeout = DEFAULT_WAIT_TIMEOUT,
    pollInterval = DEFAULT_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let deploymentHealthy = false;

    return waitFor(
      async () => {
        if (!deploymentHealthy) {
          deploymentHealthy = await this.is_deployment_healthy();
        }

        return deploymentHealthy && this.check_executor_health(signal);
      },
      timeout,
      pollInterval,
      signal,
    );
  }

  async wait_tcp_proxy_ready(
    timeout = DEFAULT_WAIT_TIMEOUT,
    pollInterval = DEFAULT_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitFor(async () => isDefined(await this.get_tcp_proxy_info()), timeout, pollInterval, signal);
  }

  async is_healthy(): Promise<boolean> {
    return (await this.is_deployment_healthy()) && this.check_executor_health();
  }

  private async resolve_deployment_id(): Promise<string | undefined> {
    if (this._deployment_id) {
      return this._deployment_id;
    }

    const service = await this.api.getService(this.service_id);
    this._deployment_id = service.active_deployment_id ?? service.latest_deployment_id;
    return this._deployment_id;
  }

  private async is_deployment_healthy(): Promise<boolean> {
    try {
      const deploymentId = await this.resolve_deployment_id();
      if (!deploymentId) {
        return false;
      }

      const deployment = await this.api.getDeployment(deploymentId);
      if (deployment.status === 'ERROR' || deployment.status === 'ERRORING') {
        throw new SandboxDeploymentError(
          `Sandbox '${this.name}' deployment reached status ${deployment.status}. The sandbox will not become ready.`,
        );
      }

      if (deployment.status !== 'HEALTHY') {
        return false;
      }

      const metadata = deployment.metadata?.sandbox;
      if (!this._conn_info && metadata?.public_url && metadata.routing_key) {
        this._conn_info = {
          public_url: `${metadata.public_url}/koyeb-sandbox`,
          routing_key: metadata.routing_key,
          secret: this.sandbox_secret,
        };
      }

      return true;
    } catch (error) {
      if (error instanceof SandboxDeploymentError) {
        throw error;
      }

      return false;
    }
  }

  private async check_executor_health(signal?: AbortSignal): Promise<boolean> {
    try {
      const body = await this.performRequest(
        '/health',
        { method: 'GET', signal },
        undefined,
        { timeout: 5, maxRetries: 0 },
        async (response) => {
          if (!response.ok) {
            return undefined;
          }

          return response.json().catch(() => undefined);
        },
      );

      if (body && typeof body === 'object' && 'status' in body && typeof body.status === 'string') {
        return ['ok', 'healthy', 'ready'].includes(body.status.toLowerCase());
      }

      return isDefined(body);
    } catch {
      return false;
    }
  }

  async get_tcp_proxy_info(): Promise<[host: string, public_port: number] | undefined> {
    try {
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
    } catch {
      return;
    }
  }

  private async get_domain_from_app(): Promise<string> {
    const app = await this.api.getApp(this.app_id);
    const domain = app.domains?.[0];

    if (!domain?.name) {
      throw new SandboxError('Sandbox URL is not available (the sandbox may no longer exist)');
    }

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
      const deploymentId = await this.resolve_deployment_id();
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
    const life_cycle = { ...service.life_cycle };

    if (isDefined(values?.delete_after_delay)) {
      life_cycle.delete_after_create = parseDuration(values.delete_after_delay);
    }

    if (isDefined(values?.delete_after_inactivity_delay)) {
      life_cycle.delete_after_sleep = parseDuration(values.delete_after_inactivity_delay);
    }

    await this.api.updateService(this.service_id, {
      definition: deployment.definition,
      life_cycle,
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

    const service = await this.api.getService(this.service_id);
    const deployment = await this.api.getDeployment(service.latest_deployment_id!);

    const updatedService = await this.api.updateService(this.service_id, {
      definition: { ...deployment.definition, network_policy },
    });

    let deploymentId = updatedService?.latest_deployment_id;
    if (!deploymentId) {
      try {
        deploymentId = (await this.api.getService(this.service_id)).latest_deployment_id;
      } catch {
        deploymentId = undefined;
      }
    }

    this.reset_connection_state(deploymentId);
  }

  private reset_connection_state(deploymentId?: string): void {
    this._deployment_id = deploymentId;
    this._conn_info = undefined;
    this._domain = undefined;
  }

  async delete(): Promise<void> {
    if (this.owns_app) {
      await this.api.deleteApp(this.app_id);
    } else {
      await this.api.deleteService(this.service_id);
    }
  }

  async snapshot(
    name: string,
    snapshotType: SnapshotType = SnapshotType.FILESYSTEM,
    waitAvailable = true,
    timeout = 600,
  ): Promise<Snapshot> {
    const instances = await this.api.listInstances({
      service_id: this.service_id,
      statuses: ['HEALTHY', 'STARTING', 'ALLOCATING'],
      limit: '1',
    });
    const instanceId = instances[0]?.id;
    assert(instanceId, new SandboxError(`No running instance found for sandbox '${this.name}'`));

    const rawSnapshot = await this.api.createInstanceSnapshot({
      instance_id: instanceId,
      name,
      type: snapshotTypeToApi(snapshotType),
    });
    const snapshot = Snapshot.fromApi(rawSnapshot, this.api_token, this.sandbox_secret);

    if (waitAvailable && !(await snapshot.wait_available(timeout))) {
      throw new SandboxTimeoutError(`snapshot ${name}`, timeout);
    }

    return snapshot;
  }

  private async performRequest<T>(
    path: string,
    init: RequestInit,
    requestBody: unknown,
    options: ExecutorRequestOptions,
    handleResponse: (response: Response) => Promise<T>,
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_HTTP_TIMEOUT;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let backoff = options.initialBackoff ?? DEFAULT_RETRY_BACKOFF;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const conn = await this.get_conn_info();
      const headers = new Headers(init.headers);
      const controller = new AbortController();
      const sourceSignal = init.signal;
      const timeoutError = SandboxTimeoutError.forRequest(timeout);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const abortFromSource = () => controller.abort(sourceSignal?.reason);
      if (sourceSignal?.aborted) {
        abortFromSource();
      } else {
        sourceSignal?.addEventListener('abort', abortFromSource, { once: true });
      }

      if (timeout > 0) {
        timeoutId = setTimeout(() => controller.abort(timeoutError), timeout * 1_000);
      }

      headers.set('Authorization', `Bearer ${conn.secret}`);
      if (conn.routing_key) {
        headers.set('X-Routing-Key', conn.routing_key);
      }

      const requestInit: RequestInit = { ...init, headers, signal: controller.signal };
      if (isDefined(requestBody)) {
        headers.set('Content-Type', 'application/json');
        requestInit.body = JSON.stringify(requestBody);
      }

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        sourceSignal?.removeEventListener('abort', abortFromSource);
      };

      try {
        const response = await globalThis.fetch(`${conn.public_url}${path}`, requestInit);

        if (response.status === 503 && attempt < maxRetries) {
          await response.body?.cancel();
          cleanup();

          if (!(await wait(backoff * 1_000, sourceSignal ?? undefined))) {
            throw sourceSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
          }

          backoff *= 2;
          continue;
        }

        return await handleResponse(response);
      } catch (error) {
        if (controller.signal.reason === timeoutError) {
          throw timeoutError;
        }

        if (sourceSignal?.aborted) {
          throw sourceSignal.reason ?? new DOMException('The operation was aborted', 'AbortError');
        }

        if (error instanceof SandboxError || error instanceof SyntaxError) {
          throw error;
        }

        throw new SandboxConnectionError(`Connection to sandbox lost: ${String(error)}`, { cause: error });
      } finally {
        cleanup();
      }
    }

    throw new SandboxError('Sandbox request failed without a response');
  }

  private async readResponseBody(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return undefined;
    }

    const contentType = response.headers.get('Content-Type');
    return contentType?.startsWith('application/json') ? response.json() : response.text();
  }

  private responseError(response: Response, responseBody: unknown): SandboxRequestError {
    if (response.status >= 500) {
      return new SandboxServiceError(response, responseBody);
    }

    return new SandboxRequestError(response, responseBody);
  }

  private assertExecutorSuccess(response: unknown, operation: string): void {
    if (!response || typeof response !== 'object') {
      return;
    }

    const result = response as { error?: unknown; success?: unknown };
    if (result.error || result.success === false) {
      throw new SandboxError(`Failed to ${operation}: ${String(result.error ?? 'Unknown error')}`);
    }
  }

  async fetch(path: string, init: RequestInit, requestBody?: unknown, options: ExecutorRequestOptions = {}) {
    return this.performRequest(path, init, requestBody, options, async (response) => response);
  }

  async request(
    path: string,
    init: RequestInit,
    requestBody?: unknown,
    options: ExecutorRequestOptions = {},
  ): Promise<any> {
    return this.performRequest(path, init, requestBody, options, async (response) => {
      const responseBody = await this.readResponseBody(response);
      if (!response.ok) {
        throw this.responseError(response, responseBody);
      }

      return responseBody;
    });
  }

  get filesystem() {
    return new SandboxFilesystem(this);
  }

  async exec(
    cmd: string,
    {
      cwd,
      env,
      signal,
      timeout = DEFAULT_HTTP_TIMEOUT,
    }: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; timeout?: number } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.request('/run', { method: 'POST', signal }, { cmd, cwd, env }, { timeout });
  }

  exec_stream(
    cmd: string,
    {
      cwd,
      env,
      signal,
      timeout = DEFAULT_HTTP_TIMEOUT,
    }: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; timeout?: number } = {},
  ): SandboxExec {
    const emitter = new EventTarget();

    this.performRequest(
      '/run_streaming',
      { method: 'POST', signal },
      { cmd, cwd, env },
      { timeout, maxRetries: 0 },
      async (response) => {
        if (!response.ok) {
          throw this.responseError(response, await this.readResponseBody(response));
        }

        if (!response.body) {
          throw new SandboxError('Sandbox executor returned an empty command stream');
        }

        await handleServerSentEvents(emitter, response.body);
      },
    ).catch((error) => {
      const streamError = error instanceof Error ? error : new SandboxError(String(error));
      emitter.dispatchEvent(new MessageEvent('error', { data: streamError }));
    });

    return emitter;
  }

  async expose_port(port: number): Promise<{ port: number; exposed_at: string }> {
    assert(port >= PORT_MIN && port <= PORT_MAX, new InvalidPortError(port));

    await this.unexpose_port();
    const response = await this.request('/bind_port', { method: 'POST' }, { port: String(port) });
    this.assertExecutorSuccess(response, `expose port ${port}`);

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

    const response = await this.request(
      '/unbind_port',
      { method: 'POST' },
      { port: isDefined(port) ? String(port) : undefined },
    );
    this.assertExecutorSuccess(response, 'unexpose port');
  }

  async launch_process(cmd: string, options?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
    const response = await this.request('/start_process', { method: 'POST' }, { cmd, ...options });
    this.assertExecutorSuccess(response, 'launch process');
    if (!response.id) {
      throw new SandboxError('Failed to launch process: no process ID returned');
    }
    return response.id;
  }

  async kill_process(processId: string): Promise<void> {
    const response = await this.request(`/kill_process`, { method: 'POST' }, { id: processId });
    this.assertExecutorSuccess(response, `kill process ${processId}`);
  }

  async list_processes(): Promise<SandboxProcess[]> {
    const response = await this.request('/list_processes', { method: 'GET' });
    this.assertExecutorSuccess(response, 'list processes');
    return response.processes ?? [];
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

function snapshotTypeToApi(type: SnapshotType): koyeb.InstanceSnapshotType {
  return type === SnapshotType.FULL ? 'INSTANCE_SNAPSHOT_TYPE_FULL' : 'INSTANCE_SNAPSHOT_TYPE_FILESYSTEM';
}

function snapshotTypeFromApi(type?: koyeb.InstanceSnapshotType): SnapshotType {
  return type === 'INSTANCE_SNAPSHOT_TYPE_FULL' ? SnapshotType.FULL : SnapshotType.FILESYSTEM;
}

function snapshotStatusFromApi(status?: koyeb.InstanceSnapshotStatus): SnapshotStatus {
  const statuses: Partial<Record<koyeb.InstanceSnapshotStatus, SnapshotStatus>> = {
    INSTANCE_SNAPSHOT_STATUS_CREATING: SnapshotStatus.CREATING,
    INSTANCE_SNAPSHOT_STATUS_AVAILABLE: SnapshotStatus.AVAILABLE,
    INSTANCE_SNAPSHOT_STATUS_ERROR: SnapshotStatus.FAILED,
    INSTANCE_SNAPSHOT_STATUS_DELETING: SnapshotStatus.DELETING,
    INSTANCE_SNAPSHOT_STATUS_DELETED: SnapshotStatus.DELETED,
  };
  return status ? (statuses[status] ?? SnapshotStatus.INVALID) : SnapshotStatus.INVALID;
}

export class Snapshot {
  public operations: string[] = [];

  private constructor(
    public readonly id: string,
    public name: string,
    public readonly service_id: string,
    public snapshot_type: SnapshotType,
    public status: SnapshotStatus,
    public created_at: Date,
    public deployment_id: string | undefined,
    public available_at: Date | undefined,
    public readonly organization_id: string,
    public readonly project_id: string | undefined,
    public messages: string[],
    private readonly api_token?: string,
    public readonly sandbox_secret?: string,
  ) {}

  static fromApi(snapshot: koyeb.InstanceSnapshot, apiToken?: string, sandboxSecret?: string): Snapshot {
    assert(snapshot.id, new SandboxError('Snapshot response has no ID'));
    return new Snapshot(
      snapshot.id,
      snapshot.name ?? '',
      snapshot.service_id ?? '',
      snapshotTypeFromApi(snapshot.type),
      snapshotStatusFromApi(snapshot.status),
      snapshot.created_at ? new Date(snapshot.created_at) : new Date(),
      snapshot.deployment_id,
      snapshot.available_at ? new Date(snapshot.available_at) : undefined,
      snapshot.organization_id ?? '',
      snapshot.project_id,
      snapshot.messages ?? [],
      apiToken,
      sandboxSecret,
    );
  }

  static async get(snapshotId: string, apiToken?: string): Promise<Snapshot> {
    const token = apiToken ?? getEnv('KOYEB_API_TOKEN');
    if (!token) {
      throw new MissingApiTokenError();
    }
    return Snapshot.fromApi(await new KoyebApi(token).getInstanceSnapshot(snapshotId), token);
  }

  static async list(
    options: {
      name?: string;
      snapshot_type?: SnapshotType;
      status?: SnapshotStatus;
      limit?: number;
      offset?: number;
      api_token?: string;
    } = {},
  ): Promise<Snapshot[]> {
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');
    if (!token) {
      throw new MissingApiTokenError();
    }

    const statusMap: Partial<Record<SnapshotStatus, koyeb.InstanceSnapshotStatus>> = {
      [SnapshotStatus.CREATING]: 'INSTANCE_SNAPSHOT_STATUS_CREATING',
      [SnapshotStatus.AVAILABLE]: 'INSTANCE_SNAPSHOT_STATUS_AVAILABLE',
      [SnapshotStatus.FAILED]: 'INSTANCE_SNAPSHOT_STATUS_ERROR',
      [SnapshotStatus.DELETING]: 'INSTANCE_SNAPSHOT_STATUS_DELETING',
      [SnapshotStatus.DELETED]: 'INSTANCE_SNAPSHOT_STATUS_DELETED',
    };
    const status = options.status ? statusMap[options.status] : undefined;
    const snapshots = await new KoyebApi(token).listInstanceSnapshots({
      name: options.name,
      type: options.snapshot_type ? snapshotTypeToApi(options.snapshot_type) : undefined,
      statuses: status ? [status] : undefined,
      limit: String(options.limit ?? 50),
      offset: String(options.offset ?? 0),
    });
    return snapshots.map((snapshot) => Snapshot.fromApi(snapshot, token));
  }

  async refresh(): Promise<void> {
    const token = this.api_token ?? getEnv('KOYEB_API_TOKEN');
    if (!token) {
      throw new MissingApiTokenError();
    }
    const updated = Snapshot.fromApi(
      await new KoyebApi(token).getInstanceSnapshot(this.id),
      token,
      this.sandbox_secret,
    );
    this.name = updated.name;
    this.snapshot_type = updated.snapshot_type;
    this.status = updated.status;
    this.created_at = updated.created_at;
    this.deployment_id = updated.deployment_id;
    this.available_at = updated.available_at;
    this.messages = updated.messages;
  }

  async wait_available(timeout = 600, pollInterval = 5): Promise<boolean> {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) / 1_000 < timeout) {
      await this.refresh();
      if (this.status === SnapshotStatus.AVAILABLE) return true;
      if (this.status === SnapshotStatus.FAILED) return false;
      await wait(pollInterval * 1_000);
    }
    return false;
  }

  async delete(): Promise<void> {
    const token = this.api_token ?? getEnv('KOYEB_API_TOKEN');
    if (!token) {
      throw new MissingApiTokenError();
    }
    await new KoyebApi(token).deleteInstanceSnapshot(this.id);
  }

  async spawn(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    return Sandbox.create({
      ...options,
      api_token: options.api_token ?? this.api_token,
      project_id: options.project_id ?? this.project_id,
      sandbox_secret: options.sandbox_secret ?? this.sandbox_secret,
      snapshot: this,
    });
  }
}

export class DeclarativeSnapshot {
  private readonly files = new Map<string, string>();
  private readonly copies: Array<{ source: string; destination: string }> = [];
  private readonly commands: Array<{ command: string; cwd?: string }> = [];

  constructor(
    private readonly name: string,
    private readonly image: string,
    private readonly options: DeclarativeSnapshotOptions = {},
  ) {}

  file(path: string, content: string): DeclarativeSnapshot {
    this.files.set(path, content);
    return this;
  }

  copy(source: string, destination: string): DeclarativeSnapshot {
    this.copies.push({ source, destination });
    return this;
  }

  run(command: string, cwd?: string): DeclarativeSnapshot {
    this.commands.push({ command, cwd });
    return this;
  }

  async build(snapshotName = this.name): Promise<Snapshot> {
    const builder = await Sandbox.create({
      image: this.image,
      name: `builder-${this.name}`,
      api_token: this.options.api_token,
      project_id: this.options.project_id,
    });
    const operations: string[] = [];

    try {
      if (this.options.workdir) {
        await builder.filesystem.mkdir(this.options.workdir, true);
        operations.push(`set_workdir: ${this.options.workdir}`);
      }

      for (const [path, content] of this.files) {
        const destination =
          path.startsWith('/') || !this.options.workdir ? path : `${this.options.workdir.replace(/\/$/, '')}/${path}`;
        await builder.filesystem.write_file(destination, content);
        operations.push(`create_file: ${destination}`);
      }

      for (const copy of this.copies) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const stat = await fs.stat(copy.source);
        const destination =
          copy.destination.startsWith('/') || !this.options.workdir
            ? copy.destination
            : `${this.options.workdir.replace(/\/$/, '')}/${copy.destination}`;
        if (stat.isDirectory()) {
          const copyDirectory = async (source: string, destination: string): Promise<void> => {
            await builder.filesystem.mkdir(destination, true);
            for (const entry of await fs.readdir(source, { withFileTypes: true })) {
              const sourcePath = path.join(source, entry.name);
              const destinationPath = path.posix.join(destination, entry.name);
              if (entry.isDirectory()) {
                await copyDirectory(sourcePath, destinationPath);
              } else {
                await builder.filesystem.write_file(destinationPath, await fs.readFile(sourcePath, 'utf8'));
              }
            }
          };
          await copyDirectory(copy.source, destination);
        } else {
          await builder.filesystem.write_file(destination, await fs.readFile(copy.source, 'utf8'));
        }
        operations.push(`copy: ${copy.source} -> ${destination}`);
      }

      for (const command of this.commands) {
        const result = await builder.exec(command.command, { cwd: command.cwd ?? this.options.workdir, timeout: 300 });
        if (result.code !== 0) {
          throw new SandboxError(`Snapshot build command failed: ${command.command}\n${result.stderr}`);
        }
        operations.push(`run: ${command.command}`);
      }

      const snapshot = await builder.snapshot(snapshotName);
      snapshot.operations = operations;
      return snapshot;
    } finally {
      if (this.options.delete_builder !== false) {
        await builder.delete();
      }
    }
  }
}
