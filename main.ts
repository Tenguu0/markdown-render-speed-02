// Driver for the markdown-render-speed-02 entry.
// The harness runs `node /bot/main.ts` on Node 22. It feeds every case
// through parse() from parse.js, one case at a time, and collects the
// HTML strings in the same order the cases arrived in. Each case is
// rendered alone: parse() keeps no state between calls, so nothing leaks
// from one case into the next.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw);

// Render in order; index assignment (not push) keeps the output aligned
// with the input even if a case renders to an empty string.
const rendered = new Array(cases.length);
for (let n = 0; n < cases.length; n++) {
  rendered[n] = parse(cases[n].markdown);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
