import * as koyeb from '@koyeb/api-client-js';
import { DEFAULT_API_HOST, DEFAULT_CLAIM_ATTEMPTS, DEFAULT_CLAIM_RETRY_DELAY_MS } from './constants.js';
import { formatRequest, formatResponse } from './format.js';
import { assert, getEnv, wait } from './utils.js';
import { SandboxApiError, ServicePoolError } from './errors.js';

export type { koyeb };

type Koyeb = typeof koyeb;
type Endpoint = keyof Koyeb;

type EndpointParam<E extends Endpoint> = Exclude<Parameters<Koyeb[E]>[0], undefined>;

type Query<E extends Endpoint> = EndpointParam<E> extends { query?: infer T } ? T : never;
type Body<E extends Endpoint> = EndpointParam<E> extends { body?: infer T } ? T : never;

export class KoyebApi {
  private readonly baseUrl: string;

  constructor(
    private readonly token?: string,
    private readonly debug = process.env.KOYEB_DEBUG === 'true',
    host?: string,
  ) {
    this.baseUrl = host ?? getEnv('KOYEB_API_HOST') ?? DEFAULT_API_HOST;
  }

  private async api<T extends { error: unknown } | { data: unknown }>(
    promise: Promise<T>,
  ): Promise<T extends { data: infer R } ? R : never> {
    const result = await promise;

    if ('error' in result) {
      const response = (result as { response?: Response }).response;
      throw new SandboxApiError(response?.status ?? 0, result.error);
    }

    return result.data as any;
  }

  private get params() {
    return {
      baseUrl: this.baseUrl,
      auth: `Bearer ${this.token}`,
      fetch: this.fetch,
    };
  }

  private fetch: typeof globalThis.fetch = async (request) => {
    assert(request instanceof Request);

    if (this.debug) {
      console.debug(await formatRequest(request));
    }

    const response = await globalThis.fetch(request);

    if (this.debug) {
      console.debug(await formatResponse(response));
      console.debug();
    }

    return response;
  };

  async getApp(id: string) {
    const response = await this.api(koyeb.getApp({ ...this.params, path: { id } }));
    return response!.app!;
  }

  async createApp(body: Body<'createApp'>) {
    const response = await this.api(koyeb.createApp({ ...this.params, body }));
    return response!.app!;
  }

  async deleteApp(id: string) {
    const response = await this.api(koyeb.deleteApp({ ...this.params, path: { id } }));
    return response!.app!;
  }

  async listServices(query: Query<'listServices'>) {
    const response = await this.api(koyeb.listServices({ ...this.params, query }));
    return response!.services!;
  }

  /** Full list reply with the total count, for paginating over every service. */
  async listServicesPage(query: Query<'listServices'>) {
    const response = await this.api(koyeb.listServices({ ...this.params, query }));
    return { services: response!.services ?? [], count: response!.count ?? 0 };
  }

  async getService(id: string) {
    const response = await this.api(koyeb.getService({ ...this.params, path: { id } }));
    return response!.service!;
  }

  async createService(body: Body<'createService'>, query?: Query<'createService'>) {
    const response = await this.api(koyeb.createService({ ...this.params, query, body }));
    return response!.service!;
  }

  async updateService(id: string, body: Body<'updateService'>, query?: Query<'updateService'>) {
    const response = await this.api(koyeb.updateService({ ...this.params, path: { id }, query, body }));
    return response!.service!;
  }

  async deleteService(id: string) {
    const response = await this.api(koyeb.deleteService({ ...this.params, path: { id } }));
    return response!.service!;
  }

  async getDeployment(id: string) {
    const response = await this.api(koyeb.getDeployment({ ...this.params, path: { id } }));
    return response!.deployment!;
  }

  async createSecret(body: Body<'createSecret'>) {
    const response = await this.api(koyeb.createSecret({ ...this.params, body }));
    return response!.secret!;
  }

  async deleteSecret(id: string) {
    await this.api(koyeb.deleteSecret({ ...this.params, path: { id } }));
  }

  async claim(body: Body<'claim'>): Promise<koyeb.PoolClaimReply> {
    let attempt = 1;

    for (; ;) {
      const result = await koyeb.claim({ ...this.params, body });

      if (result.error !== undefined) {
        const status = result.response?.status;

        if (attempt >= DEFAULT_CLAIM_ATTEMPTS || !isRetryableClaimStatus(status)) {
          throw result.error;
        }

        await wait(DEFAULT_CLAIM_RETRY_DELAY_MS * attempt);
        attempt += 1;
        continue;
      }

      return result.data;
    }
  }

  async getClaim(claimId: string) {
    const response = await this.api(koyeb.getClaim({ ...this.params, path: { claim_id: claimId } }));
    return response!.claim!;
  }

  async createServicePool(body: Body<'createServicePool'>) {
    const response = await this.api(koyeb.createServicePool({ ...this.params, body }));
    return response!.service_pool!;
  }

  async getServicePool(id: string) {
    const response = await this.api(koyeb.getServicePool({ ...this.params, path: { id } }));
    return response!.service_pool!;
  }

  async listServicePools(query?: Query<'listServicePools'>) {
    const response = await this.api(koyeb.listServicePools({ ...this.params, query }));
    return response!.service_pools ?? [];
  }

  async updateServicePool(id: string, body: Body<'updateServicePool'>) {
    const response = await this.api(koyeb.updateServicePool({ ...this.params, path: { id }, body }));
    return response!.service_pool!;
  }

  async deleteServicePool(id: string) {
    const response = await this.fetch(
      new Request(`${this.baseUrl}/v1/service_pools/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.token}` },
      }),
    );

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ServicePoolError(
        `Failed to delete service pool '${id}': ${response.status} ${response.statusText}${body ? `: ${JSON.stringify(body)}` : ''}`,
      );
    }
  }

  async listClaims(poolId: string, query?: Query<'listClaim'>) {
    const response = await this.api(koyeb.listClaim({ ...this.params, path: { pool_id: poolId }, query }));
    return response!.claims ?? [];
  }

  async listDeployments(query?: Query<'listDeployments'>) {
    const response = await this.api(koyeb.listDeployments({ ...this.params, query }));
    return response!.deployments ?? [];
  }

  async listInstances(query?: Query<'listInstances'>) {
    const response = await this.api(koyeb.listInstances({ ...this.params, query }));
    return response!.instances ?? [];
  }

  async createInstanceSnapshot(body: Body<'createInstanceSnapshot'>) {
    const response = await this.api(koyeb.createInstanceSnapshot({ ...this.params, body }));
    return response!.instance_snapshot!;
  }

  async getInstanceSnapshot(id: string) {
    const response = await this.api(koyeb.getInstanceSnapshot({ ...this.params, path: { id } }));
    return response!.instance_snapshot!;
  }

  async listInstanceSnapshots(query?: Query<'listInstanceSnapshots'>) {
    const response = await this.api(koyeb.listInstanceSnapshots({ ...this.params, query }));
    return response!.instance_snapshots ?? [];
  }

  async deleteInstanceSnapshot(id: string) {
    const response = await this.api(koyeb.deleteInstanceSnapshot({ ...this.params, path: { id } }));
    return response!.instance_snapshot!;
  }
}

// Claiming is idempotent per (pool_id, request_id): only transient failures (no response, 429, 5xx) are retried.
function isRetryableClaimStatus(status: number | undefined) {
  return status === undefined || status === 429 || status >= 500;
}
