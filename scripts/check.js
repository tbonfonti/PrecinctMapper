import { readFile } from 'node:fs/promises';

const files = ['src/app.js'];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  new Function(source);
}
console.log('Static application syntax check passed.');
