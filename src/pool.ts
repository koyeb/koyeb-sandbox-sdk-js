import { randomUUID } from 'node:crypto';

import { koyeb, KoyebApi } from './api.js';
import { DEFAULT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT } from './constants.js';
import { MissingApiTokenError, PoolClaimError, ServiceTerminalStateError } from './errors.js';
import { assert, getEnv, waitFor } from './utils.js';

/**
 * Options for claiming a sandbox from a pool.
 */
export type ClaimOptions = Partial<{
  /**
   * Idempotency key of the claim. Generated once (UUID v4) when omitted and
   * preserved across the SDK's internal retries: replaying a claim with the
   * same `(pool_id, request_id)` pair always returns the same claim.
   */
  request_id: string;
  /** API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
}>;

/**
 * A sandbox claimed from a service pool. `service_id` is always present;
 * `sandbox_id` is optional and only set when the API returns it.
 */
export type ClaimResult = {
  claim_id: string;
  pool_id: string;
  request_id: string;
  service_id: string;
  prewarmed: boolean;
  sandbox_id?: string;
};

/**
 * Options for fetching a claim's state.
 */
export type GetClaimOptions = Partial<{
  /** Request id the claim was created with, disambiguating replayed claims. */
  request_id: string;
  /** API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
}>;

/**
 * Options for the cold-path readiness poll.
 */
export type WaitClaimReadyOptions = Partial<{
  /** Seconds to wait before giving up. Defaults to 300. */
  timeout: number;
  /** Seconds between Get Service polls. Defaults to 2. */
  poll_interval: number;
  /** API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
  /** Aborts waiting early. */
  signal: AbortSignal;
}>;

/**
 * Claim a sandbox from a service pool.
 *
 * On the warm path (`prewarmed: true`) the claimed sandbox is already running.
 * On the cold path (`prewarmed: false`) a new sandbox service is created on
 * demand: `service_id` is returned immediately and the sandbox becomes usable
 * once the service is ready — see `wait_claim_ready`.
 *
 * Claiming is idempotent: replaying with the same `(pool_id, request_id)` pair
 * returns the same claim without consuming another pool member.
 */
export async function claim(poolId: string, options: ClaimOptions = {}): Promise<ClaimResult> {
  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  // Generated once here and reused verbatim across KoyebApi.claim's internal
  // retries, so a retried claim replays the same logical claim.
  const request_id = options.request_id ?? randomUUID();

  // `sandbox_id` is optional in the API contract: the reply may or may not
  // carry it, so it is read defensively and never required.
  const reply = (await api.claim({ pool_id: poolId, request_id })) as koyeb.PoolClaimReply & {
    sandbox_id?: string;
  };

  assert(reply.claim_id, new PoolClaimError('The pool claim reply did not include a claim_id'));
  assert(reply.service_id, new PoolClaimError('The pool claim reply did not include a service_id'));

  return {
    claim_id: reply.claim_id,
    pool_id: poolId,
    request_id,
    service_id: reply.service_id,
    prewarmed: reply.prewarmed ?? false,
    sandbox_id: reply.sandbox_id,
  };
}

/**
 * Fetch the current state of a claim (`PENDING`, `FULFILLED`, `FAILED` or
 * `RELEASED`).
 */
export async function get_claim(claimId: string, options: GetClaimOptions = {}): Promise<koyeb.PoolClaim> {
  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  return api.getClaim(claimId, options.request_id);
}

/**
 * Cold-path state classification, per the mapping finalized in KOYEB-6290:
 * `HEALTHY` and `DEGRADED` are usable, `STARTING` and `RESUMING` are still in
 * progress, and every other state — including unknown forward-compat values —
 * is a terminal failure for the claim poll (fail closed).
 */
function classifyServiceStatus(status: koyeb.ServiceStatus): 'ready' | 'in_progress' | 'terminal_failure' {
  if (status === 'HEALTHY' || status === 'DEGRADED') {
    return 'ready';
  }

  if (status === 'STARTING' || status === 'RESUMING') {
    return 'in_progress';
  }

  return 'terminal_failure';
}

/**
 * Cold-path helper: poll Get Service until the claimed sandbox is ready.
 *
 * Resolves to `true` once the service is `HEALTHY` or `DEGRADED` (usable), or
 * `false` if it is not ready within `timeout` seconds. Throws
 * `ServiceTerminalStateError` as soon as the service reaches a state it
 * cannot recover from.
 */
export async function wait_claim_ready(
  target: ClaimResult | string,
  options: WaitClaimReadyOptions = {},
): Promise<boolean> {
  const service_id = typeof target === 'string' ? target : target.service_id;

  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  return waitFor(
    async () => {
      const status = (await api.getService(service_id)).status;

      if (status === undefined) {
        return false;
      }

      const classification = classifyServiceStatus(status);

      if (classification === 'terminal_failure') {
        throw new ServiceTerminalStateError(service_id, status);
      }

      return classification === 'ready';
    },
    options.timeout ?? DEFAULT_WAIT_TIMEOUT,
    options.poll_interval ?? DEFAULT_POLL_INTERVAL,
    options.signal,
  );
}
