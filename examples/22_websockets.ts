import assert from 'node:assert/strict';

import { assertCommand, retry, runExample, sleep, withSandbox } from './_helpers.js';

const server = `
import asyncio
import json
import websockets

async def handler(ws):
    async for message in ws:
        await ws.send(json.dumps({"echo": json.loads(message), "server": "sandbox"}))

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

asyncio.run(main())
`;

async function exchange(url: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => socket.send(message));
    socket.addEventListener('message', (event) => {
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
  });
}

await runExample('WebSocket connection', async () => {
  await withSandbox('websockets', {}, async (sandbox) => {
    assertCommand(await sandbox.exec('pip install websockets', { timeout: 300 }), 'install websockets');
    await sandbox.filesystem.write_file('/tmp/ws_server.py', server);
    assert.ok(await sandbox.launch_process('python3 /tmp/ws_server.py'));
    await sleep(2);

    const exposed = await sandbox.expose_port(8765);
    const url = exposed.exposed_at.replace(/^http/, 'ws');
    const response = await retry(() => exchange(url, JSON.stringify({ msg: 'hello' })));
    assert.deepEqual(JSON.parse(response), { echo: { msg: 'hello' }, server: 'sandbox' });
  });
});
