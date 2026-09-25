import { vi } from 'vitest';

import { Sandbox } from './sandbox.js';

/** Shared scaffolding for the executor/SSE-mocking tests. Excluded from the build. */

export function makeSandbox() {
  return new Sandbox('app-1', 'svc-1', 'sbx', 'secret', 'token');
}

export function sseResponse(chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

export const outputEvent = (stream: 'stdout' | 'stderr', data: string) =>
  `event: output\ndata: ${JSON.stringify({ stream, data })}\n\n`;

export const completeEvent = (payload: Record<string, unknown>) =>
  `event: complete\ndata: ${JSON.stringify(payload)}\n\n`;

/** Mock exec's SSE route to yield the given result, with a fresh body per call. */
export function mockExec(sandbox: Sandbox, result: { stdout?: string; stderr?: string; code?: number }) {
  return vi.spyOn(sandbox, 'fetch').mockImplementation(async () =>
    sseResponse([
      ...(result.stdout ? [outputEvent('stdout', result.stdout)] : []),
      ...(result.stderr ? [outputEvent('stderr', result.stderr)] : []),
      completeEvent({ code: result.code ?? 0, error: false }),
    ]),
  );
}
