import fs from 'node:fs/promises';

const files = await fs.readdir(import.meta.dirname);
const examples = files.filter((f) => !f.startsWith('00') && f.endsWith('.ts'));

for (const example of examples) {
  await import(`./${example}`);
}
