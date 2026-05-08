import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PIN_FILENAME = join('.myceliate', 'sector.txt');
const KEBAB = /^[a-z][a-z0-9-]*$/;

function pinPath(cwd: string): string {
  return join(cwd, PIN_FILENAME);
}

export async function readPin(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(pinPath(cwd), 'utf8');
    const trimmed = raw.trim();
    if (!KEBAB.test(trimmed)) {
      console.warn(
        `[spores] pin file ${pinPath(cwd)} contained invalid name "${trimmed}"; ignoring`,
      );
      return null;
    }
    return trimmed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writePin(cwd: string, name: string): Promise<void> {
  if (!KEBAB.test(name)) throw new Error(`refusing to pin invalid name "${name}"`);
  const path = pinPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${name}\n`, 'utf8');
}

export async function clearPin(cwd: string): Promise<void> {
  try {
    await unlink(pinPath(cwd));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
