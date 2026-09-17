import * as koyeb from '@koyeb/api-client-js';
import { DEFAULT_API_HOST, DEFAULT_CLAIM_ATTEMPTS, DEFAULT_CLAIM_RETRY_DELAY_MS } from './constants.js';
import { formatRequest, formatResponse } from './format.js';
import { assert, getEnv, wait } from './utils.js';

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
  ) {
    this.baseUrl = getEnv('KOYEB_API_HOST') ?? DEFAULT_API_HOST;
  }

  private async api<T extends { error: Error } | { data: unknown }>(
    promise: Promise<T>,
  ): Promise<T extends { data: infer R } ? R : never> {
    const result = await promise;

    if ('error' in result) {
      throw result.error;
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

    for (;;) {
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

  async getClaim(claimId: string, requestId?: string) {
    const query = requestId !== undefined ? { request_id: requestId } : undefined;
    const response = await this.api(koyeb.getClaim({ ...this.params, path: { claim_id: claimId }, query }));
    return response!.claim!;
  }
}

// Claiming is idempotent per (pool_id, request_id), so transient failures are
// safe to retry: network-level errors (no response) and rate-limit or server
// errors replay the same claim. Client errors (validation, auth, missing pool)
// are surfaced immediately.
function isRetryableClaimStatus(status: number | undefined) {
  return status === undefined || status === 429 || status >= 500;
}
