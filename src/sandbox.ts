import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_READY_POLL_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  PORT_MAX,
  PORT_MIN,
  READY_POLL_INITIAL_INTERVAL,
} from './constants.js';
import {
  InvalidPortError,
  MissingApiTokenError,
  NoSandboxSecretError,
  SandboxDeploymentError,
  SandboxRequestError,
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

/**
 * Deployment-status classification for readiness, failing closed: `HEALTHY` and `DEGRADED` are ready, the
 * pre-ready states are in progress, and every other state (including `SLEEPING`, `STASHED` and unknown values)
 * will not become ready on its own during a wait.
 */
function classifyDeploymentStatus(status: koyeb.DeploymentStatus): 'ready' | 'in_progress' | 'terminal_failure' {
  switch (status) {
    case 'HEALTHY':
    case 'DEGRADED':
      return 'ready';
    case 'PENDING':
    case 'PROVISIONING':
    case 'SCHEDULED':
    case 'ALLOCATING':
    case 'STARTING':
      return 'in_progress';
    default:
      return 'terminal_failure';
  }
}

/** The gateway URL and routing key the platform publishes in the deployment metadata, when present. */
function metadataConnectionInfo(deployment: koyeb.Deployment): { public_url: string; routing_key: string } | undefined {
  const sandbox = (deployment.metadata as koyeb.DeploymentMetadata | undefined)?.sandbox;

  if (sandbox?.public_url && sandbox?.routing_key) {
    return { public_url: sandbox.public_url, routing_key: sandbox.routing_key };
  }
}

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
    timeout: DEFAULT_WAIT_TIMEOUT,
    idle_timeout: DEFAULT_IDLE_TIMEOUT,
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
      block_network: opts.block_network,
      outbound_allowlist: opts.outbound_allowlist,
    });

    const service = await this.createService(token, opts, definition);
    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, sandbox_secret, token);
    sandbox._deployment_id = service.latest_deployment_id;

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
    const deployment = await api.getDeployment(service.latest_deployment_id!);

    const secret = deployment.definition?.env?.find(({ key }) => key === 'SANDBOX_SECRET');

    assert(secret?.value, new NoSandboxSecretError());

    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, secret.value, token);
    sandbox._deployment_id = deployment.id;
    sandbox.cache_conn_info(deployment);

    return sandbox;
  }

  /**
   * Waits for the deployment to be HEALTHY, then for the executor's `/health` to answer. Both are polled with
   * backoff, from 0.1 s doubling up to `pollInterval` seconds. Probing the gateway before HEALTHY would not
   * help: the sandbox's address is not published yet, and a lookup that fails can be cached for a few seconds.
   *
   * Resolves `true` once ready and `false` on timeout or abort. Throws `SandboxDeploymentError` as soon as the
   * deployment reaches a status that will not become ready (e.g. `ERROR`, `STOPPED`, `SLEEPING`).
   */
  async wait_ready(
    timeout = DEFAULT_WAIT_TIMEOUT,
    pollInterval = DEFAULT_READY_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const start = Date.now();
    let interval = Math.min(READY_POLL_INITIAL_INTERVAL, pollInterval);
    let deployment_healthy = false;

    do {
      // An already-aborted signal never fires wait()'s listener: stop up front.
      if (signal?.aborted) {
        return false;
      }

      if (!deployment_healthy) {
        deployment_healthy = await this.is_deployment_healthy();
      }

      if (deployment_healthy && (await this.is_executor_healthy())) {
        return true;
      }

      await wait(interval * 1_000, signal);
      interval = Math.min(interval * 2, pollInterval);
    } while (Date.now() - start < timeout * 1_000);

    return false;
  }

  async wait_tcp_proxy_ready(
    timeout = DEFAULT_WAIT_TIMEOUT,
    pollInterval = DEFAULT_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitFor(async () => isDefined(await this.get_tcp_proxy_info()), timeout, pollInterval, signal);
  }

  async is_healthy(): Promise<boolean> {
    const conn = await this.get_conn_info();
    const headers: Record<string, string> = { Authorization: `Bearer ${conn.secret}` };

    if (conn.routing_key) {
      headers['X-Routing-Key'] = conn.routing_key;
    }

    const response = await fetch(`${conn.public_url}/health`, { headers });

    return response.ok;
  }

  private async resolve_deployment_id(): Promise<string | undefined> {
    if (!this._deployment_id) {
      const service = await this.api.getService(this.service_id);
      this._deployment_id = service.active_deployment_id || service.latest_deployment_id;
    }

    return this._deployment_id;
  }

  /** Whether the deployment is HEALTHY; API errors count as not yet. Caches the connection info once healthy. */
  private async is_deployment_healthy(): Promise<boolean> {
    let deployment: koyeb.Deployment;

    try {
      const deploymentId = await this.resolve_deployment_id();

      if (!deploymentId) {
        return false;
      }

      deployment = await this.api.getDeployment(deploymentId);
    } catch {
      return false;
    }

    if (isUndefined(deployment.status)) {
      return false;
    }

    const classification = classifyDeploymentStatus(deployment.status);

    if (classification === 'terminal_failure') {
      throw new SandboxDeploymentError(this.name, deployment.status);
    }

    if (classification === 'ready') {
      this.cache_conn_info(deployment);
      return true;
    }

    return false;
  }

  /** Whether the executor answers `/health`; a network error counts as not ready. */
  private async is_executor_healthy(): Promise<boolean> {
    try {
      const response = await this.fetch('/health', { method: 'GET' });
      // Read the body so the connection goes back to the pool for the next request.
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  private cache_conn_info(deployment: koyeb.Deployment) {
    const metadata = metadataConnectionInfo(deployment);

    if (!this._conn_info && metadata) {
      this._conn_info = {
        public_url: `${metadata.public_url}/koyeb-sandbox`,
        routing_key: metadata.routing_key,
        secret: this.sandbox_secret,
      };
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
      const service = await this.api.getService(this.service_id);
      const deploymentId = service.active_deployment_id || service.latest_deployment_id;
      if (!deploymentId) return;

      return metadataConnectionInfo(await this.api.getDeployment(deploymentId));
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

    const updated = await this.api.updateService(this.service_id, {
      definition: deployment.definition,
      life_cycle: {
        delete_after_create: parseDuration(values?.delete_after_delay),
        delete_after_sleep: parseDuration(values?.delete_after_inactivity_delay),
      },
    });

    // The update redeploys: later readiness checks follow the new deployment.
    this._deployment_id = updated.latest_deployment_id;
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

    const updated = await this.api.updateService(this.service_id, {
      definition: { ...deployment.definition, network_policy },
    });

    // The update redeploys: later readiness checks follow the new deployment.
    this._deployment_id = updated.latest_deployment_id;
  }

  async delete(): Promise<void> {
    await this.api.deleteApp(this.app_id);
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

  async request(path: string, init: RequestInit, requestBody?: unknown) {
    const response = await this.fetch(path, init, requestBody);

    const contentType = response.headers.get('Content-Type');
    const responseBody = contentType?.startsWith('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new SandboxRequestError(response, responseBody);
    }

    return responseBody;
  }

  get filesystem() {
    return new SandboxFilesystem(this);
  }

  async exec(
    cmd: string,
    { cwd, env, signal }: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.request('/run', { method: 'POST', signal }, { cmd, cwd, env });
  }

  exec_stream(
    cmd: string,
    { cwd, env, signal }: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
  ): SandboxExec {
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
