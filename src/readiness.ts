import type { koyeb } from './api.js';

export type StatusClassification = 'ready' | 'in_progress' | 'terminal_failure';

const SERVICE_READY: koyeb.ServiceStatus[] = ['HEALTHY', 'DEGRADED'];
const SERVICE_IN_PROGRESS: koyeb.ServiceStatus[] = ['STARTING', 'RESUMING'];

const DEPLOYMENT_READY: koyeb.DeploymentStatus[] = ['HEALTHY', 'DEGRADED'];
const DEPLOYMENT_IN_PROGRESS: koyeb.DeploymentStatus[] = [
  'PENDING',
  'PROVISIONING',
  'SCHEDULED',
  'ALLOCATING',
  'STARTING',
];

/**
 * One classification engine, failing closed: statuses outside the ready and
 * in-progress sets are terminal, so unknown forward-compat values never read
 * as ready (Python parity).
 */
function classify<T extends string>(status: T | undefined, ready: readonly T[], inProgress: readonly T[]) {
  if (status && ready.includes(status)) {
    return 'ready';
  }

  if (status && inProgress.includes(status)) {
    return 'in_progress';
  }

  return 'terminal_failure';
}

/** Claim-path classification: usable vs in-progress vs terminal service states. */
export function classifyServiceStatus(status: koyeb.ServiceStatus | undefined): StatusClassification {
  return classify(status, SERVICE_READY, SERVICE_IN_PROGRESS);
}

/** Sandbox-path classification: deployment states that can still become ready. */
export function classifyDeploymentStatus(status?: koyeb.DeploymentStatus): StatusClassification {
  return classify(status, DEPLOYMENT_READY, DEPLOYMENT_IN_PROGRESS);
}
