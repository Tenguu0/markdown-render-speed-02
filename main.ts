// Entry driver for markdown-render-speed-02.
//
// The scorer runs this file with Node 22. It hands us a directory of
// cases and expects one HTML string per case, in the same order, written
// out as a JSON array. Every case goes through parse() on its own: the
// renderer keeps no state from one call to the next, so no result can
// leak into another case and no cache can make a later case cheaper.
//
// Input : $MAKEFUN_INPUT_DIR/cases.json  (default /input/cases.json)
//         a JSON array of { id, markdown } objects.
// Output: $MAKEFUN_OUTPUT_DIR/html.json  (default /output/html.json)
//         a JSON array of HTML strings, same order as the input.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
