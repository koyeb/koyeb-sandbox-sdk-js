import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

type Options = {
  flows: string[];
  timeoutSeconds: number;
};

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const flowsIndex = args.indexOf('--flows');
  const timeoutIndex = args.indexOf('--timeout');
  return {
    flows: flowsIndex >= 0 ? args[flowsIndex + 1].split(',') : ['all'],
    timeoutSeconds: timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 900,
  };
}

function matches(name: string, flows: string[]): boolean {
  if (flows.includes('all')) return true;
  return flows.some((flow) => name === flow || name.startsWith(flow.replace(/\*$/, '')));
}

async function run(file: string, timeoutSeconds: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: process.env, stdio: 'inherit' });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(file)} exceeded ${timeoutSeconds} seconds`));
    }, timeoutSeconds * 1_000);

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

const options = parseOptions();
const allFiles = (await fs.readdir(import.meta.dirname)).filter(
  (file) => /^\d{2}_.+\.js$/.test(file) && !file.startsWith('00_'),
);
const expectedNumbers = Array.from({ length: 26 }, (_, index) => String(index + 1).padStart(2, '0'));
const presentNumbers = new Set(allFiles.map((file) => file.slice(0, 2)));
const missingNumbers = expectedNumbers.filter((number) => !presentNumbers.has(number));
if (missingNumbers.length > 0) throw new Error(`Missing example scenarios: ${missingNumbers.join(', ')}`);

const files = allFiles.filter((file) => matches(file.replace(/\.js$/, ''), options.flows)).sort();

if (files.length === 0) throw new Error('No examples match the selected flows');

for (const file of files) {
  console.log(`\n▶ ${file}`);
  await run(path.join(import.meta.dirname, file), options.timeoutSeconds);
}

console.log(`\n✓ ${files.length} examples passed`);
