import { RunFailedError } from './errors.js';

export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export class SandboxExecutor {
  private readonly headers: Headers;

  constructor(
    private readonly base_url: string,
    private readonly secret: string,
  ) {
    this.headers = new Headers();

    this.headers.set('Authorization', `Bearer ${this.secret}`);
    this.headers.set('Content-Type', 'application/json');
  }

  private url(path: string) {
    return this.base_url + path;
  }

  async run(cmd: string, cwd?: string, env?: string, signal?: AbortSignal): Promise<RunResult> {
    const response = await fetch(this.url('/run'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ cmd, cwd, env }),
      signal,
    });

    const contentType = response.headers.get('Content-Type');
    const body = contentType?.startsWith('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      throw new RunFailedError(response, body);
    }

    return body;
  }
}
