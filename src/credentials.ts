import { KoyebApi } from './api.js';
import { MissingApiTokenError } from './errors.js';
import { getEnv } from './prelude.js';

export type ClientOptions = Partial<{ api_token: string; host: string }>;

/**
 * Resolve the Koyeb client for an SDK entry point: the explicit token wins
 * over KOYEB_API_TOKEN, and a missing token fails fast (Python parity).
 */
export function resolveClient(options: ClientOptions = {}) {
  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  return { token, client: new KoyebApi(token, undefined, options.host) };
}
