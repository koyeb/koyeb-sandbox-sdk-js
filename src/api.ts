import * as koyeb from '@koyeb/api-client-js';
import { DEFAULT_API_HOST } from './constants.js';
import { formatRequest, formatResponse } from './format.js';
import { assert, getEnv } from './utils.js';

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
}
