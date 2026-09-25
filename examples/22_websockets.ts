/**
 * WebSocket communication: run a ws echo server in the sandbox, expose its port,
 * and exchange messages with it over wss://.
 */
import { Sandbox } from '@koyeb/sandbox-sdk';

const apiToken = process.env.KOYEB_API_TOKEN;
if (!apiToken) {
  console.error('Error: KOYEB_API_TOKEN not set');
  process.exit(1);
}

const suffix = Math.random().toString(36).slice(2, 10);

// Python asyncio echo server, run inside the sandbox.
const WS_SERVER_SCRIPT = String.raw`
import asyncio
import websockets
import json

async def handler(ws):
    async for message in ws:
        data = json.loads(message)
        response = {"echo": data, "server": "sandbox"}
        await ws.send(json.dumps(response))

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8765):
        await asyncio.Future()

asyncio.run(main())
`;

async function connect(url: string): Promise<WebSocket> {
  // Node's built-in WebSocket client (Node >= 22).
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)), { once: true });
  });
}

async function roundTrip(ws: WebSocket, payload: unknown): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    ws.addEventListener(
      'message',
      (event) => {
        resolve(JSON.parse(String(event.data)));
      },
      { once: true },
    );
    ws.addEventListener('error', () => reject(new Error('send failed')), { once: true });
    ws.send(JSON.stringify(payload));
  });
}

async function main() {
  const sandbox = await Sandbox.create({
    image: 'koyeb/sandbox:slim',
    name: `websockets-${suffix}`,
    wait_ready: true,
    api_token: apiToken,
  });

  try {
    console.log('Installing websockets in sandbox...');
    const install = await sandbox.exec('pip install websockets');
    if (install.code !== 0) {
      throw new Error(`Failed to install websockets: ${install.stderr}`);
    }

    console.log('Starting WebSocket server...');
    await sandbox.filesystem.write_file('/tmp/ws_server.py', WS_SERVER_SCRIPT);
    const processId = await sandbox.launch_process('python3 /tmp/ws_server.py');
    console.log(`Server started with process ID: ${processId}`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    console.log('\nExposing port 8765...');
    const exposed = await sandbox.expose_port(8765);
    console.log(`Exposed at: ${exposed.exposed_at}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const wsUrl = exposed.exposed_at.replace('https://', 'wss://').replace('http://', 'ws://');
    console.log(`\nConnecting to ${wsUrl}...`);

    const ws = await connect(wsUrl);
    try {
      // Send a few messages and check the echo.
      for (let i = 1; i <= 3; i++) {
        const payload = { msg: `hello ${i}` };
        const response = (await roundTrip(ws, payload)) as { echo: { msg: string } };
        console.log(`  Sent: ${JSON.stringify(payload)}`);
        console.log(`  Received: ${JSON.stringify(response)}`);
        if (response.echo.msg !== `hello ${i}`) {
          throw new Error(`Echo mismatch: ${JSON.stringify(response)}`);
        }
      }
    } finally {
      ws.close();
    }

    console.log('\n✓ WebSocket echo test passed');
  } finally {
    await sandbox.delete();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
