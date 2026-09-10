export async function handleServerSentEvents(
  emitter: EventTarget,
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const event of events) {
      handleEvent(emitter, parseEvent(event));
    }

    if (done) {
      if (buffer.trim()) {
        handleEvent(emitter, parseEvent(buffer));
      }
      return;
    }
  }
}

function handleEvent(emitter: EventTarget, event: Partial<{ event: string; data: string }>): void {
  if (!event.data) {
    return;
  }

  const data = JSON.parse(event.data);

  if (event.event === 'output' && (data.stream === 'stdout' || data.stream === 'stderr')) {
    emitter.dispatchEvent(new MessageEvent(data.stream, { data }));
    return;
  }

  if (event.event === 'complete') {
    emitter.dispatchEvent(new MessageEvent('exit', { data }));
    emitter.dispatchEvent(new Event('end'));
    return;
  }

  if (event.event === 'error') {
    const error = new Error(typeof data.error === 'string' ? data.error : 'Sandbox command stream failed');
    emitter.dispatchEvent(new MessageEvent('error', { data: error }));
  }
}

function parseEvent(input: string): Partial<{ event: string; data: string }> {
  const event: Partial<{ event: string; data: string }> = {};
  const data: string[] = [];

  for (const line of input.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).trimStart();

    if (key === 'data') {
      data.push(value);
    } else if (key === 'event') {
      event.event = value;
    }
  }

  if (data.length > 0) {
    event.data = data.join('\n');
  }

  return event;
}
