import { koyeb, KoyebApi } from './api.js';
import {
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_POOL_IMAGE,
  DEFAULT_POOL_INSTANCE_TYPE,
  DEFAULT_POOL_SIZE,
} from './constants.js';
import { resolveClient } from './credentials.js';
import { ServicePoolError } from './errors.js';
import type { ConfigFile, EnvValue } from './sandbox.js';
import type { ListClaimsOptions } from './claim.js';
import { assert, omitUndefined } from './prelude.js';
import { buildDefinition, type DefinitionOptions } from './definition.js';

/**
 * Options for creating a service pool. Shares definition fields with
 * `Sandbox.create` via `DefinitionOptions`, minus the sandbox-only `enable_mesh`
 * (mesh stays AUTO on pools) and `sandbox_secret` (the platform mints pool
 * secrets). Defaults to `type: SANDBOX`; WEB and WORKER are accepted.
 */
export type CreatePoolOptions = Omit<DefinitionOptions, 'enable_mesh' | 'sandbox_secret'> &
  Partial<{
    /** Target number of pre-warmed members to maintain. Defaults to 1. */
    size: number;
    /** API token, overriding `process.env.KOYEB_API_TOKEN`. */
    api_token: string;
    /** Target API host, overriding `KOYEB_API_HOST`. */
    host: string;
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
 * the reconciler completes the teardown, fenced on active claims.
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
    // Databases are out of scope for pools (product rule); every other
    // service type is poolable. Fail before any API call.
    if (options.type === 'DATABASE') {
      throw new ServicePoolError(
        'DATABASE pools are not supported: pools accept SANDBOX (default), WEB, and WORKER definitions',
      );
    }

    // Fail-fast wiring validation (cross-client rule): sandbox pools own
    // ports 3030/3031, and sandbox-only flags never apply to other types.
    const type = options.type ?? 'SANDBOX';

    if (type === 'SANDBOX' && (options.ports !== undefined || options.routes !== undefined)) {
      throw new ServicePoolError(
        'explicit ports/routes are not allowed on SANDBOX pools: the sandbox wiring owns ports 3030/3031',
      );
    }

    if (
      type !== 'SANDBOX' &&
      (options.exposed_port_protocol !== undefined || options.enable_tcp_proxy !== undefined)
    ) {
      throw new ServicePoolError(
        'exposed_port_protocol and enable_tcp_proxy are sandbox-only options and are not allowed on WEB/WORKER pools',
      );
    }

    const { token, client: api } = resolveClient(options);

    // Options are a DefinitionOptions superset: thread them whole so no
    // accepted field can be silently dropped by hand-maintaining this list.
    const { definition } = buildDefinition({ ...options, name });

    const pool = await api.createServicePool(
      omitUndefined({ name, size: options.size ?? DEFAULT_POOL_SIZE, definition }),
    );

    return ServicePool._from_model(pool, token);
  }

  static async get(poolId: string, options: { api_token?: string } = {}): Promise<ServicePool> {
    const { token, client: api } = resolveClient(options);
    const pool = await api.getServicePool(poolId);

    return ServicePool._from_model(pool, token);
  }

  static async list(options: ListPoolsOptions = {}): Promise<ServicePool[]> {
    const { token, client: api } = resolveClient(options);
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
