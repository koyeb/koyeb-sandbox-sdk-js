import { Sandbox } from '@koyeb/sandbox-sdk';
import { Buffer } from 'buffer';

const sandbox = await Sandbox.create({ name: 'binary-files', image: 'koyeb/sandbox:slim' });
console.log(`Sandbox ID: ${sandbox.id}`);
const fs = sandbox.filesystem;

async function main() {
  const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
  await fs.write_file('/tmp/binary.bin', binaryData);

  const decoded = await fs.read_file('/tmp/binary.bin', { encoding: null });

  console.log('Original:', Buffer.from(binaryData).toString('hex'));
  console.log('Decoded:', Buffer.from(decoded).toString('hex'));

  if (Buffer.compare(Buffer.from(binaryData), Buffer.from(decoded)) !== 0) {
    throw new Error('Decoded data does not match original');
  }
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
