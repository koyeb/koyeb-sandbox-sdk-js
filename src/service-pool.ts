import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_POOL_IMAGE,
  DEFAULT_POOL_INSTANCE_TYPE,
  DEFAULT_POOL_SIZE,
} from './constants.js';
import { MissingApiTokenError, ServicePoolError } from './errors.js';
import type { ConfigFile, EnvValue } from './sandbox.js';
import type { ListClaimsOptions } from './pool.js';
import { assert, buildDefinition, getEnv, omitUndefined } from './utils.js';
import type { DefinitionOptions } from './utils.js';

/**
 * Options for creating a service pool. Shares definition fields with
 * `Sandbox.create` via `DefinitionOptions`; adds pool-specific `size` and
 * `type`. Defaults to `type: SANDBOX` but other service types (WEB, WORKER,
 * DATABASE) are accepted.
 */
export type CreatePoolOptions = DefinitionOptions &
  Partial<{
    /** Target number of pre-warmed members to maintain. Defaults to 1. */
    size: number;
    /** API token, overriding `process.env.KOYEB_API_TOKEN`. */
    api_token: string;
  }>;

/**
 * Options for updating a service pool. At least one of `size` or `definition`
 * must be provided.
 */
export type UpdatePoolOptions = Partial<{
  /** New target pool size. */
  size: number;
  /** New deployment definition (triggers a generation bump). */
  definition: koyeb.DeploymentDefinition;
}>;

/**
 * Options for listing service pools.
 */
export type ListPoolsOptions = Partial<{
  /** Filter by pool name. */
  name: string;
  /** Pagination limit (string per the API). */
  limit: string;
  /** Pagination offset (string per the API). */
  offset: string;
  /** API token, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
}>;

/**
 * A Koyeb service pool — a set of pre-provisioned sandboxes that can be
 * claimed on demand.
 *
 * Pool deletion is async server-side: the pool enters `DELETING` status and
 * the reconciler completes the teardown, fenced on active claims. The DELETE
 * endpoint is rolling out; `delete()` ships ready and surfaces the API error
 * until the route is live.
 */
export class ServicePool {
  private readonly api: KoyebApi;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly size: number | undefined,
    public readonly ready_count: number | undefined,
    public readonly status: koyeb.ServicePoolStatus | undefined,
    public readonly definition: koyeb.DeploymentDefinition | undefined,
    private readonly api_token?: string,
  ) {
    this.api = new KoyebApi(api_token);
  }

  static async create(name: string, options: CreatePoolOptions = {}): Promise<ServicePool> {
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const { definition } = buildDefinition({
      name,
      type: options.type,
      image: options.image,
      instance_type: options.instance_type,
      region: options.region,
      env: options.env,
      config_files: options.config_files,
      privileged: options.privileged,
      registry_secret: options.registry_secret,
      exposed_port_protocol: options.exposed_port_protocol,
      enable_tcp_proxy: options.enable_tcp_proxy,
      idle_timeout: options.idle_timeout,
      _experimental_enable_light_sleep: options._experimental_enable_light_sleep,
      block_network: options.block_network,
      outbound_allowlist: options.outbound_allowlist,
    });

    const api = new KoyebApi(token);
    const pool = await api.createServicePool(
      omitUndefined({ name, size: options.size ?? DEFAULT_POOL_SIZE, definition }),
    );

    return ServicePool._from_model(pool, token);
  }

  static async get(poolId: string, options: { api_token?: string } = {}): Promise<ServicePool> {
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const api = new KoyebApi(token);
    const pool = await api.getServicePool(poolId);

    return ServicePool._from_model(pool, token);
  }

  static async list(options: ListPoolsOptions = {}): Promise<ServicePool[]> {
    const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

    if (!token) {
      throw new MissingApiTokenError();
    }

    const api = new KoyebApi(token);
    const pools = await api.listServicePools(
      omitUndefined({ name: options.name, limit: options.limit, offset: options.offset }),
    );

    return pools.map((p) => ServicePool._from_model(p, token));
  }

  async update(options: UpdatePoolOptions): Promise<ServicePool> {
    if (options.size === undefined && options.definition === undefined) {
      throw new ServicePoolError('At least one of size or definition must be provided');
    }

    const pool = await this.api.updateServicePool(
      this.id,
      omitUndefined({ size: options.size, definition: options.definition }),
    );

    return ServicePool._from_model(pool, this.api_token);
  }

  async delete(): Promise<void> {
    await this.api.deleteServicePool(this.id);
  }

  async refresh(): Promise<ServicePool> {
    const pool = await this.api.getServicePool(this.id);

    return ServicePool._from_model(pool, this.api_token);
  }

  async claims(options: Omit<ListClaimsOptions, 'api_token'> = {}): Promise<koyeb.PoolClaim[]> {
    return this.api.listClaims(
      this.id,
      omitUndefined({ status: options.status, limit: options.limit, offset: options.offset }),
    );
  }

  private static _from_model(model: koyeb.ServicePool, token?: string): ServicePool {
    assert(model.id, new ServicePoolError('The pool reply did not include an id'));
    assert(model.name, new ServicePoolError('The pool reply did not include a name'));

    return new ServicePool(model.id, model.name, model.size, model.ready_count, model.status, model.definition, token);
  }
}
