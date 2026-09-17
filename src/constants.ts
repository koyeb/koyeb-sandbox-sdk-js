export const DEFAULT_API_HOST = 'https://app.koyeb.com';
export const DEFAULT_WAIT_TIMEOUT = 300;
export const DEFAULT_IDLE_TIMEOUT = 300;
export const DEFAULT_POLL_INTERVAL = 2;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

// Total attempts for an idempotent pool claim before surfacing the last error.
export const DEFAULT_CLAIM_ATTEMPTS = 3;
// Base backoff between claim attempts; grows linearly with the attempt count.
export const DEFAULT_CLAIM_RETRY_DELAY_MS = 1_000;
