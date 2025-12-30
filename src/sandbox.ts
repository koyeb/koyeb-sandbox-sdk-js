import { koyeb, KoyebApi } from './api.js';
import { DEFAULT_INSTANCE_WAIT_TIMEOUT, DEFAULT_POLL_INTERVAL, PORT_MAX, PORT_MIN } from './constants.js';
import {
  InvalidPortError,
  MissingApiTokenError,
  NoSandboxSecretError,
  SandboxRequestError,
  SandboxTimeoutError,
} from './errors.js';
import { SandboxFilesystem } from './sandbox-filesystem.js';
import { handleServerSentEvents } from './server-sent-event.js';
import { TypedEventTarget } from './typed-event-target.js';
import { assert, Duration, getEnv, isDefined, isUndefined, parseDuration, randomString, waitFor } from './utils.js';

export type CreateSandboxOptions = Partial<{
  image: string;
  name: string;
  wait_ready: boolean;
  instance_type: string;
  exposed_port_protocol: 'http' | 'http2';
  env: Record<string, string>;
  region: string;
  api_token: string;
  timeout: number;
  idle_timeout: number;
  enable_tcp_proxy: boolean;
  privileged: false;
  registry_secret?: string;
  delete_after_delay?: Duration;
  delete_after_inactivity_delay?: Duration;
  _experimental_enable_light_sleep: false;
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

export class Sandbox {
  private readonly api: KoyebApi;
  private domain?: koyeb.Domain;

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
    timeout: DEFAULT_INSTANCE_WAIT_TIMEOUT,
    idle_timeout: 300,
  } satisfies CreateSandboxOptions;

  static async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const opts = { ...this.defaultCreateSandboxOptions, ...options };
    const token = opts.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const definition: koyeb.DeploymentDefinition = {
      name: opts.name,
      type: 'SANDBOX',
      docker: {
        image: opts.image,
        privileged: opts.privileged,
        image_registry_secret: opts.registry_secret,
      },
      instance_types: [{ type: opts.instance_type }],
      regions: [opts.region ?? 'na'],
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

    definition.env ??= [];
    definition.env.push({ key: 'SANDBOX_SECRET', value: sandbox_secret });

    for (const [key, value] of Object.entries(opts.env ?? {})) {
      definition.env.push({ key, value });
    }

    const { idle_timeout } = opts;
    let sleep_idle_delay: koyeb.DeploymentScalingTargetSleepIdleDelay | undefined = undefined;

    if (idle_timeout > 0) {
      if (opts._experimental_enable_light_sleep) {
        sleep_idle_delay = { light_sleep_value: idle_timeout, deep_sleep_value: 3900 };
      } else {
        sleep_idle_delay = { deep_sleep_value: idle_timeout };
      }
    }

    definition.scalings = [
      {
        min: sleep_idle_delay ? 0 : 1,
        max: 1,
        targets: [{ sleep_idle_delay }],
      },
    ];

    if (opts.enable_tcp_proxy) {
      definition.proxy_ports = [{ port: 3031, protocol: 'tcp' }];
    }

    const service = await this.createService(token, opts, definition);
    const sandbox = new Sandbox(service.app_id!, service.id!, service.name!, sandbox_secret, token);

    if (opts.wait_ready && !(await sandbox.wait_ready(opts.timeout))) {
      throw new SandboxTimeoutError(sandbox.name, opts.timeout);
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
      life_cycle: {},
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

    return new Sandbox(service.app_id!, service.id!, service.name!, secret.value, token);
  }

  async wait_ready(
    timeout = DEFAULT_INSTANCE_WAIT_TIMEOUT,
    pollInterval = DEFAULT_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitFor(() => this.is_healthy(), timeout, pollInterval, signal);
  }

  async wait_tcp_proxy_ready(
    timeout = DEFAULT_INSTANCE_WAIT_TIMEOUT,
    pollInterval = DEFAULT_POLL_INTERVAL,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitFor(async () => isDefined(await this.get_tcp_proxy_info()), timeout, pollInterval, signal);
  }

  async is_healthy(): Promise<boolean> {
    const url = await this.get_sandbox_url();
    const response = await fetch(`${url}/health`);

    return response.ok;
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

  async get_domain() {
    if (this.domain) {
      return this.domain;
    }

    const app = await this.api.getApp(this.app_id);
    const domain = app.domains?.[0];

    assert(domain);
    this.domain = domain;

    return this.domain;
  }

  async get_sandbox_url(): Promise<string> {
    const domain = await this.get_domain();
    const name = domain.name;

    assert(name);

    return `https://${name}/koyeb-sandbox`;
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

  async delete(): Promise<void> {
    await this.api.deleteApp(this.app_id);
  }

  async fetch(path: string, init: RequestInit, requestBody?: unknown) {
    init.headers = new Headers(init.headers);

    init.headers.set('Authorization', `Bearer ${this.sandbox_secret}`);

    if (isDefined(requestBody)) {
      init.headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(requestBody);
    }

    return fetch(`${await this.get_sandbox_url()}${path}`, init);
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

    assert(isDefined(domain.name));

    return {
      port,
      exposed_at: `https://${domain.name}`,
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
