type SseEvent = Partial<{ event: string; data: string }>;

/**
 * Parse one SSE event payload. Mirroring the Python client, unparseable data
 * becomes an error-carrying payload instead of a raised exception.
 */
function parseEventData(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return { error: `Failed to parse event data: ${raw}` };
  }
}

/**
 * Consume the executor's Server-Sent Events stream, dispatching typed events:
 * `stdout`/`stderr` output chunks, `exit` for completions, failed starts, and
 * unparseable payloads, plus `end` once the stream finishes.
 */
export function handleServerSentEvents(
  emitter: EventTarget,
  stream: ReadableStream<Uint8Array>,
  onChunk?: () => void,
) {
  let buffer = '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  async function pump() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        onChunk?.();

        if (done) {
          // Flush the decoder and parse any EOF-terminated leftover event.
          handleText(decoder.decode());

          if (buffer.trim()) {
            handleEvent(parseEvent(buffer));
          }
          return;
        }

        handleText(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      // Release the stream so the response body is not left locked; cancel
      // rejects on already-errored streams, so release the lock too.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      throw error;
    }
  }

  function handleText(text: string) {
    buffer += text;

    for (;;) {
      // The SSE format allows both LF and CRLF line endings.
      const separator = /\r?\n\r?\n/.exec(buffer);

      if (!separator) {
        return;
      }

      const event = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      handleEvent(parseEvent(event));
    }
  }

  function handleEvent(event: SseEvent) {
    if (event.event === 'output') {
      const data = parseEventData(event.data);

      if (typeof data.stream === 'string') {
        emitter.dispatchEvent(new MessageEvent(data.stream, { data }));
      } else {
        // Malformed output: surface it as a failure, like Python's parser.
        emitter.dispatchEvent(new MessageEvent('exit', { data: { error: `Failed to parse event data: ${event.data}` } }));
      }
      return;
    }

    if (event.event === 'complete' || event.event === 'error') {
      // Complete carries {code, error}; error carries the failed-start reason.
      // Both mean the command is over, so both dispatch exit before end.
      emitter.dispatchEvent(new MessageEvent('exit', { data: parseEventData(event.data) }));
      emitter.dispatchEvent(new Event('end'));
    }
  }

  return pump();
}

function parseEvent(input: string): SseEvent {
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

  // Multiple data lines join with newlines, per the SSE format.
  if (data.length > 0) {
    event.data = data.join('\n');
  }

  return event;
}
