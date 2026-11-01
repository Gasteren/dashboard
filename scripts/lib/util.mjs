import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hash(text, length = 16) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length);
}

export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const inActions = process.env.GITHUB_ACTIONS === 'true';

export function info(message) {
  console.log(message);
}

export function warn(message) {
  console.warn(inActions ? `::warning::${message}` : `warning: ${message}`);
}

export function group(title) {
  console.log(inActions ? `::group::${title}` : `\n== ${title} ==`);
}

export function endGroup() {
  if (inActions) console.log('::endgroup::');
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${error.message}`);
  }
}

export async function writeJson(file, data, { pretty = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = pretty ? `${JSON.stringify(data, null, 2)}\n` : JSON.stringify(data);
  await writeFile(file, text, 'utf8');
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function toTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}
