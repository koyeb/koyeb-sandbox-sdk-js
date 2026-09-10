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
    const region = opts.region ?? getEnv('KOYEB_REGION') ?? 'na';

    if (!token) {
      throw new MissingApiTokenError();
    }

    // Validate egress arguments before any API call so invalid input fails fast.
    const network_policy = buildNetworkPolicy(opts.block_network, opts.outbound_allowlist);

    const definition: koyeb.DeploymentDefinition = {
      name: opts.name,
      type: 'SANDBOX',
      docker: {
        image: opts.image,
        privileged: opts.privileged,
        image_registry_secret: opts.registry_secret,
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

    const sandbox_secret = randomString(32);

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

    const service = await this.createService(token, opts, definition);
    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, sandbox_secret, token);

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
    definition: koyeb.DeploymentDefinition,
  ) {
    const api = new KoyebApi(token);

    await api.createService({ app_id: '74140198-4d29-4a1e-bdc9-5cc2b355ccd0', definition }, { dry_run: true });

    const app = await api.createApp({
      name: `sandbox-app-${opts.name}-${Date.now()}`,
      life_cycle: { delete_when_empty: true },
    });

    try {
      return await api.createService({
        app_id: app.id,
        definition,
        life_cycle: {
          delete_after_create: parseDuration(opts.delete_after_delay),
          delete_after_sleep: parseDuration(opts.delete_after_inactivity_delay),
        },
      });
    } catch (error) {
      await api.deleteApp(app.id!);
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
    await this.api.deleteApp(this.app_id);
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
