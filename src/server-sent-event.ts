export function handleServerSentEvents(emitter: EventTarget, stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
  let buffer = '';

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  return reader.read().then(pump);

  async function pump({ done, value }: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>) {
    handleChunk(decoder.decode(value));

    if (done) {
      handleChunk(buffer);
    } else {
      await reader.read().then(pump);
    }
  }

  function handleChunk(eventString: string) {
    buffer += eventString;

    while (buffer.includes('\n\n')) {
      const [event] = buffer.split('\n\n', 1);

      buffer = buffer.slice(event.length + 2);
      handleEvent(parseEvent(event));
    }
  }

  function handleEvent(event: Partial<{ event: string; data: string }>) {
    if (event.event === 'output') {
      const data = JSON.parse(event.data!);
      emitter.dispatchEvent(new MessageEvent(data.stream, { data }));
    }

    if (event.event === 'complete') {
      emitter.dispatchEvent(new Event('end'));
    }
  }
}

function parseEvent(input: string): Partial<{ event: string; data: string }> {
  const lines = input.split('\n');
  const event: Partial<Record<string, string>> = {};

  for (const line of lines) {
    const [key] = line.split(':', 1);
    event[key] = line.slice(key.length + 1).trim();
  }

  return event;
}
