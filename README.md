# markdown-render-speed-02

[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Tenguu0/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Tenguu0/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, single-file Markdown renderer written from scratch in
plain JavaScript. `parse(markdown)` returns exactly the HTML that
[marked](https://github.com/markedjs/marked) 18.1.3 renders with its default
options (GFM on, breaks off) — CommonMark 0.31.2 plus the GFM 0.29 extensions
(tables, strikethrough, task lists, autolinks) — but faster, with no
dependencies and no caching between cases. It is a drop-in replacement for
marked's default output: same bytes in, same bytes out.

Built for the [make.fun](https://make.fun/bounty/markdown-render-speed-02)
bounty "Make Markdown rendering faster" ($250 to the top 20).

## Layout

- `parse.js` — the renderer. One pure function, `parse(markdown)`, no
  dependencies, no file or network access, no state kept between calls.
- `main.ts` — the harness driver. Reads the cases, renders each one alone
  with `parse()`, writes the HTML strings out in case order.

## How to run

```sh
# Render the practice set (cases.json in $MAKEFUN_INPUT_DIR):
node main.ts

# Or render a single string from the command line:
node -e "import('./parse.js').then(m => console.log(m.parse('# hi\n')))"
```

`main.ts` reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input/cases.json`)
and writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output/html.json`), a
JSON array of HTML strings, one per case, in the cases' order. No install
step is needed: the entry uses only Node's built-in modules and the two
source files in this repository.

## License

MIT — see [LICENSE](LICENSE).
