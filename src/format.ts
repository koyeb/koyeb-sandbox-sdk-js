export async function formatRequest(req: Request) {
  const request = req.clone();
  let body = request.body ? await readStream(request.body) : undefined;

  try {
    body = JSON.stringify(JSON.parse(body!), null, 2);
  } catch {}

  return [
    //
    `${request.method} ${request.url}`,
    ...formatHeaders(request.headers),
    ...(body ? ['', body] : []),
  ].join('\n');
}

export async function formatResponse(res: Response) {
  const response = res.clone();
  let body = response.body ? await readStream(response.body) : undefined;

  try {
    body = JSON.stringify(JSON.parse(body!), null, 2);
  } catch {}

  return [
    //
    `${response.url} ${response.status} ${response.statusText}`,
    ...formatHeaders(response.headers),
    ...(body ? ['', body] : []),
  ].join('\n');
}

function formatHeaders(headers: Headers) {
  return Array.from(headers.entries())
    .map(([key, value]) => (key.toLowerCase() === 'authorization' ? [key, '****'] : [key, value]))
    .map(([key, value]) => `${key}: ${value}`);
}

async function readStream(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let result = '';

  return reader.read().then(function process({ done, value }): Promise<string> {
    if (done) {
      return Promise.resolve(result);
    }

    result += decoder.decode(value);

    return reader.read().then(process);
  });
}
