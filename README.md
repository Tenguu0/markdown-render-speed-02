# markdown-render-speed-02

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Tenguu0/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Tenguu0/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A single-file Markdown renderer in plain JavaScript, written from scratch
with no dependencies. `parse(markdown)` produces byte-for-byte the HTML
that [marked](https://github.com/markedjs/marked) 18.1.3 produces with its
default settings (GFM on, breaks off) — CommonMark 0.31.2 plus the GFM 0.29
extensions (tables, strikethrough, task lists, autolinks) — only faster.
Same bytes in, same bytes out; a drop-in replacement for marked's default
output.

Built for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
bounty "Make Markdown rendering faster" ($250 to the top 20).

## Files

- `parse.js` — the whole renderer. One pure function, `parse(markdown)`.
  No dependencies, no file or network access, no state kept between calls.
- `main.ts` — the harness driver. Reads the cases, renders each one alone
  with `parse()`, writes the HTML strings out in case order.

## Running it

```sh
# Render the practice set (cases.json under $MAKEFUN_INPUT_DIR):
node main.ts

# Or render one string from the command line:
node -e "import('./parse.js').then(m => console.log(m.parse('# hi\n')))"
```

`main.ts` reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input/cases.json`)
and writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output/html.json`): a
JSON array of HTML strings, one per case, in the cases' order. There is no
install step — the entry uses only Node's built-in modules plus the two
source files in this repository.

## License

MIT — see [LICENSE](LICENSE).
