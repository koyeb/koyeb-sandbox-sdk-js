import type { koyeb } from './api.js';
import { PORT_MAX, PORT_MIN } from './constants.js';

/**
 * Base class for every error raised by this SDK, mirroring the Python SDK's
 * `SandboxError` so callers can catch SDK failures with a single type.
 */
export class SandboxError extends Error {}

export class MissingApiTokenError extends SandboxError {
  constructor() {
    super('API token is required. Set KOYEB_API_TOKEN environment variable or pass api_token parameter');
  }
}

export class InvalidPortError extends SandboxError {
  constructor(value: number) {
    super(`Port must be an integer between ${PORT_MIN} and ${PORT_MAX}, got ${value}`);
  }
}

export class SandboxTimeoutError extends SandboxError {
  constructor(
    public readonly name: string,
    public timeout: number,
    message?: string,
  ) {
    super(
      message ??
        [
          `Sandbox '${name}' did not become ready within ${timeout} seconds.`,
          'The sandbox was created but may not be ready yet.',
          'You can check its status with sandbox.is_healthy() or call sandbox.wait_ready() again.',
        ].join(' '),
    );
  }
}

export class NoSandboxSecretError extends SandboxError {
  constructor(message = 'The SANDBOX_SECRET environment variable is not set') {
    super(message);
  }
}

function formatBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * Executor returned a non-OK HTTP response. Carries status and body like the
 * Python SDK; SandboxServiceError subclasses it so one catch covers every
 * executor HTTP failure.
 */
export class SandboxRequestError extends SandboxError {
  constructor(
    public readonly status_code: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Sandbox executor request failed: ${status_code} ${formatBody(body)}`);
  }
}

export class EgressPolicyError extends SandboxError {
  constructor(message: string) {
    super(message);
  }
}

export class PoolClaimError extends SandboxError {
  constructor(message: string) {
    super(message);
  }
}

export class ServiceTerminalStateError extends SandboxError {
  constructor(
    public readonly service_id: string,
    public readonly status: koyeb.ServiceStatus,
  ) {
    super(`Service '${service_id}' reached terminal state '${status}' and will not become ready.`);
  }
}

export class ServicePoolError extends SandboxError {
  constructor(message: string) {
    super(message);
  }
}

export class SandboxFilesystemError extends SandboxError {
  constructor(message: string) {
    super(message);
  }
}

export class SandboxFileNotFoundError extends SandboxFilesystemError {}

export class SandboxFileExistsError extends SandboxFilesystemError {}

/**
 * API request failed with a non-2xx response. Carries the HTTP status and the
 * parsed error body so callers can branch on failures without touching raw
 * client types.
 */
export class SandboxApiError extends SandboxError {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message?: unknown }).message)
        : '';
    super(`Koyeb API request failed: ${status}${message ? `: ${message}` : ''}`);
  }
}

/** A command exited non-zero while `raise_on_error` was opted in (Python parity). */
export class SandboxCommandError extends SandboxError {
  constructor(
    public readonly result: { command: string; stdout: string; stderr: string; code: number },
  ) {
    super(`Command '${result.command}' failed with exit code ${result.code}: ${result.stderr || result.stdout}`);
  }

  /** Python's CommandResult names the exit code `exit_code`. */
  get exit_code(): number {
    return this.result.code;
  }

  get success(): boolean {
    return this.result.code === 0;
  }
}

/** The sandbox executor kept answering 5xx after the retry budget (Python parity). */
export class SandboxServiceError extends SandboxRequestError {
  constructor(status_code: number, message: string) {
    super(status_code, message, `Sandbox service error (${status_code}): ${message}`);
  }
}

/** The sandbox deployment reached a terminal error state and will not become ready (Python parity). */
export class SandboxDeploymentError extends SandboxError {
  constructor(name: string, status: string) {
    super(
      `Sandbox '${name}' deployment reached status ${status} — it will not become ready; wake or redeploy the sandbox.`,
    );
  }
}
