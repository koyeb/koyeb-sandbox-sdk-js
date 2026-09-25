export const DEFAULT_API_HOST = 'https://app.koyeb.com';
export const DEFAULT_WAIT_TIMEOUT = 300;
// Standalone readiness waits are shorter than create's budget (Python parity).
export const DEFAULT_INSTANCE_WAIT_TIMEOUT = 60;
export const DEFAULT_IDLE_TIMEOUT = 300;
export const DEFAULT_POLL_INTERVAL = 0.5;
// Command execution timeout in seconds (Python parity).
export const DEFAULT_COMMAND_TIMEOUT = 30;
// First delay of a readiness wait: doubles up to DEFAULT_POLL_INTERVAL (Python parity).
export const DEFAULT_WAIT_START_INTERVAL = 0.1;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

// Claim readiness polls slower than sandbox readiness (Python parity).
export const DEFAULT_CLAIM_POLL_INTERVAL = 2;

// Total attempts for an idempotent pool claim before surfacing the last error.
export const DEFAULT_CLAIM_ATTEMPTS = 3;
// Base backoff between claim attempts; grows linearly with the attempt count.
export const DEFAULT_CLAIM_RETRY_DELAY_MS = 1_000;

// Executor 503 retries before surfacing SandboxServiceError (Python parity).
export const DEFAULT_EXECUTOR_RETRIES = 3;
// Base backoff between executor retries; doubles with the attempt count.
export const DEFAULT_EXECUTOR_RETRY_DELAY_MS = 1_000;

// Service pool defaults.
export const DEFAULT_POOL_SIZE = 1;
export const DEFAULT_POOL_IMAGE = 'koyeb/sandbox';
export const DEFAULT_POOL_INSTANCE_TYPE = 'micro';

// Snapshot availability wait (Python parity).
export const DEFAULT_SNAPSHOT_WAIT_TIMEOUT = 600;
export const DEFAULT_SNAPSHOT_POLL_INTERVAL = 5;
