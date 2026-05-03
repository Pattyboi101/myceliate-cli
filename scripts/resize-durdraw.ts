// scripts/resize-durdraw.ts
// Pad an existing durdraw .dur file to a larger canvas size, in-place.
// Existing art is preserved at the top-left; new cells are blank (space + [16,0]).
//
// Usage: pnpm tsx scripts/resize-durdraw.ts <path> <newWidth> <newHeight>
//        pnpm tsx scripts/resize-durdraw.ts ~/Myceliate/myceliate_title 160 30
//
// After resizing, open in durdraw to redraw across the full canvas, save, then
// re-run `pnpm tsx scripts/build-banner.ts` to regenerate the Ink module.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

const [, , path, widthArg, heightArg] = process.argv;
if (!path || !widthArg || !heightArg) {
  console.error('usage: resize-durdraw <path> <newWidth> <newHeight>');
  process.exit(1);
}
const newWidth = Number.parseInt(widthArg, 10);
const newHeight = Number.parseInt(heightArg, 10);
if (!Number.isFinite(newWidth) || !Number.isFinite(newHeight) || newWidth < 1 || newHeight < 1) {
  console.error('width and height must be positive integers');
  process.exit(1);
}

type DurFrame = {
  frameNumber: number;
  delay: number;
  contents: string[];
  colorMap: Array<Array<[number, number]>>;
};
type DurMovie = {
  DurMovie: { sizeX: number; sizeY: number; frames: DurFrame[]; [k: string]: unknown };
};

const raw = readFileSync(path);
const movie = JSON.parse(gunzipSync(raw).toString('utf8')) as DurMovie;
const oldWidth = movie.DurMovie.sizeX;
const oldHeight = movie.DurMovie.sizeY;

if (newWidth < oldWidth || newHeight < oldHeight) {
  console.error(
    `refusing to shrink: existing ${oldWidth}×${oldHeight} > requested ${newWidth}×${newHeight}`,
  );
  process.exit(1);
}

for (const frame of movie.DurMovie.frames) {
  // Pad each row's content string with spaces to newWidth.
  const newContents: string[] = [];
  for (let row = 0; row < newHeight; row += 1) {
    const existing = frame.contents[row] ?? '';
    newContents.push(existing.padEnd(newWidth, ' '));
  }
  frame.contents = newContents;

  // Pad colorMap: structure is colorMap[col][row] = [fg, bg].
  // Existing columns: extend each to newHeight rows. Add new columns (oldWidth..newWidth-1).
  const newColorMap: Array<Array<[number, number]>> = [];
  for (let col = 0; col < newWidth; col += 1) {
    const existingCol = frame.colorMap[col];
    const newCol: Array<[number, number]> = [];
    for (let row = 0; row < newHeight; row += 1) {
      const cell = existingCol?.[row];
      // Default fill: fg=16 (black), bg=0 (default-black). Looks blank.
      newCol.push(cell ?? [16, 0]);
    }
    newColorMap.push(newCol);
  }
  frame.colorMap = newColorMap;
}

movie.DurMovie.sizeX = newWidth;
movie.DurMovie.sizeY = newHeight;

// Durdraw's loader checks the first 12 bytes for the literal sequence
// `{\n  "DurMovi` (curly + newline + 2 spaces + DurMovi). Compact JSON output
// (`{"DurMov...`) fails that check and durdraw renders the file as raw ASCII.
// Always emit with 2-space indentation.
const json = JSON.stringify(movie, null, 2);
const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
writeFileSync(path, compressed);
console.log(`resized ${path}: ${oldWidth}×${oldHeight} → ${newWidth}×${newHeight}`);
console.log('open in durdraw and redraw, then re-run scripts/build-banner.ts');
