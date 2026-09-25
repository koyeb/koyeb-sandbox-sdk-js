import { randomUUID } from 'node:crypto';

import { koyeb, KoyebApi } from './api.js';
import { DEFAULT_CLAIM_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT } from './constants.js';
import { MissingApiTokenError, PoolClaimError, ServiceTerminalStateError } from './errors.js';
import { assert, getEnv, omitUndefined, waitFor } from './utils.js';

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
 * A sandbox claimed from a service pool. `service_id` is always present.
 */
export type ClaimResult = {
  claim_id: string;
  pool_id: string;
  request_id: string;
  service_id: string;
  prewarmed: boolean;
};

/**
 * Options for fetching a claim's state.
 */
export type GetClaimOptions = Partial<{
  /** API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
}>;

/**
 * Options for listing claims on a pool.
 */
export type ListClaimsOptions = Partial<{
  /** Filter by claim status (e.g. `FULFILLED`, `PENDING`). */
  status: string;
  /** Pagination limit (string per the API). */
  limit: string;
  /** Pagination offset (string per the API). */
  offset: string;
  /** API token for authentication, overriding `process.env.KOYEB_API_TOKEN`. */
  api_token: string;
}>;

/**
 * Options for the service-readiness poll.
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

  const request_id = options.request_id ?? randomUUID();

  const reply = await api.claim({ pool_id: poolId, request_id });

  assert(reply.claim_id, new PoolClaimError('The pool claim reply did not include a claim_id'));
  assert(reply.service_id, new PoolClaimError('The pool claim reply did not include a service_id'));

  return {
    claim_id: reply.claim_id,
    pool_id: poolId,
    request_id,
    service_id: reply.service_id,
    prewarmed: reply.prewarmed ?? false,
  };
}

/**
 * Fetch the current state of a claim (`UNSPECIFIED`, `PENDING`, `FULFILLED`,
 * `FAILED` or `RELEASED`).
 */
export async function get_claim(claimId: string, options: GetClaimOptions = {}): Promise<koyeb.PoolClaim> {
  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  return api.getClaim(claimId);
}

/**
 * List claims on a service pool, optionally filtered by status.
 */
export async function list_claims(poolId: string, options: ListClaimsOptions = {}): Promise<koyeb.PoolClaim[]> {
  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  return api.listClaims(
    poolId,
    omitUndefined({ status: options.status, limit: options.limit, offset: options.offset }),
  );
}

/**
 * Service-status classification: `HEALTHY` and `DEGRADED` are usable,
 * `STARTING` and `RESUMING` are still in progress, and every other state —
 * including unknown forward-compat values — is a terminal failure (fail
 * closed). Not cold-path-specific: this is general service health.
 */
export function classifyServiceStatus(status: koyeb.ServiceStatus): 'ready' | 'in_progress' | 'terminal_failure' {
  if (status === 'HEALTHY' || status === 'DEGRADED') {
    return 'ready';
  }

  if (status === 'STARTING' || status === 'RESUMING') {
    return 'in_progress';
  }

  return 'terminal_failure';
}

/**
 * Poll Get Service until the claimed sandbox is ready.
 *
 * General service-health polling: resolves `true` on ready, `false` on
 * timeout, throws `ServiceTerminalStateError` on terminal states. Used after
 * a claim (cold path) but applicable to any service.
 */
export async function wait_claim_ready(
  claimOrServiceId: ClaimResult | string,
  options: WaitClaimReadyOptions = {},
): Promise<boolean> {
  const service_id = typeof claimOrServiceId === 'string' ? claimOrServiceId : claimOrServiceId.service_id;

  const token = options.api_token ?? getEnv('KOYEB_API_TOKEN');

  if (!token) {
    throw new MissingApiTokenError();
  }

  const api = new KoyebApi(token);

  return waitFor(
    async () => {
      let status: koyeb.ServiceStatus | undefined;

      try {
        status = (await api.getService(service_id)).status;
      } catch {
        // Any Get Service failure is treated as in-progress and retried until
        // the timeout: transient blips (network, 5xx, 404 during propagation)
        // dominate while a cold claim provisions, and the timeout bounds the
        // wait.
        return false;
      }

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
    options.poll_interval ?? DEFAULT_CLAIM_POLL_INTERVAL,
    options.signal,
  );
}
