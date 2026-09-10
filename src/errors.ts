import { PORT_MAX, PORT_MIN } from './constants.js';

export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

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
  public readonly sandboxName?: string;

  constructor(
    sandboxName: string,
    public readonly timeout: number,
  ) {
    super(
      [
        `Sandbox '${sandboxName}' did not become ready within ${timeout} seconds.`,
        'The sandbox was created but may not be ready yet.',
        'You can check its status with sandbox.is_healthy() or call sandbox.wait_ready() again.',
      ].join(' '),
    );
    this.sandboxName = sandboxName;
  }

  static forRequest(timeout: number): SandboxTimeoutError {
    const error = new SandboxTimeoutError('request', timeout);
    error.message = `Sandbox executor request timed out after ${timeout} seconds.`;
    return error;
  }
}

export class SandboxDeploymentError extends SandboxError {}

export class SandboxConnectionError extends SandboxError {}

export class NoSandboxSecretError extends SandboxError {
  constructor() {
    super('The SANDBOX_SECRET environment variable is not set');
  }
}

export class SandboxRequestError extends SandboxError {
  constructor(
    public readonly response: Response,
    public readonly body: unknown,
  ) {
    super(`Sandbox executor request failed: ${response.status} ${response.statusText}`);
  }
}

export class SandboxServiceError extends SandboxRequestError {
  constructor(response: Response, body: unknown) {
    super(response, body);
    this.name = new.target.name;
    this.message = `Sandbox service error (${response.status}): ${
      typeof body === 'string' ? body : JSON.stringify(body)
    }`;
  }
}

export class SandboxFilesystemError extends SandboxError {}

export class SandboxFileNotFoundError extends SandboxFilesystemError {}

export class SandboxFileExistsError extends SandboxFilesystemError {}

export class EgressPolicyError extends SandboxError {
  constructor(message: string) {
    super(message);
  }
}
