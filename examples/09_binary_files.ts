import { Sandbox } from '@koyeb/sandbox-sdk';
import { Buffer } from 'buffer';

const sandbox = await Sandbox.create({ name: 'binary-files' });
const fs = sandbox.filesystem;

async function main() {
  const binaryData = '\x00\x01\x02\x03\xff\xfe\xfd';
  const base64Data = Buffer.from(binaryData).toString('base64');
  await fs.write_file('/tmp/binary.bin', base64Data);

  const fileInfo = await fs.read_file('/tmp/binary.bin');
  const decoded = Buffer.from(fileInfo.content, 'base64').toString();

  console.log('Original:', binaryData);
  console.log('Decoded:', decoded);

  if (binaryData !== decoded) {
    throw new Error('Decoded data does not match original');
  }
}

async function cleanup() {
  await sandbox.delete();
}

main().catch(console.error).finally(cleanup);
