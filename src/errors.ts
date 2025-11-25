export class MissingApiTokenError extends Error {
  constructor() {
    super('API token is required. Set KOYEB_API_TOKEN environment variable or pass api_token parameter');
  }
}

export class SandboxTimeoutError extends Error {
  constructor(
    public readonly name: string,
    public timeout: number,
  ) {
    super(
      [
        `Sandbox '${name}' did not become ready within ${timeout} seconds.`,
        'The sandbox was created but may not be ready yet.',
        'You can check its status with sandbox.is_healthy() or call sandbox.wait_ready() again.',
      ].join(' '),
    );
  }
}

export class NoSandboxSecretError extends Error {
  constructor() {
    super('The SANDBOX_SECRET environment variable is not set');
  }
}

export class RunFailedError extends Error {
  constructor(
    public readonly response: Response,
    public readonly body: unknown,
  ) {
    super('Sandbox executor run failed');
  }
}
