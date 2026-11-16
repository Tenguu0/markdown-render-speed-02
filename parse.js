// A fast, dependency-free Markdown renderer. parse(markdown) returns
// exactly the HTML marked 18.1.3 returns with its default options (GFM on,
// breaks off): CommonMark 0.31.2 plus the GFM 0.29 extensions (tables,
// strikethrough, task lists, autolinks). Written from scratch against the
// specs and checked byte for byte against marked's own output on the
// practice set.
//
// Shape of the file: tiny character predicates and escapers up top, then
// the inline pass (one scan over the text; brackets settle when they
// close, emphasis settles afterwards per sibling list), then the block
// pass (a container stack walked line by line), then rendering. parse()
// is pure — nothing is kept between calls.

// ASCII punctuation, for backslash escapes and the ASCII fast paths.
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// A literal '&' that must come out as &amp;. It is produced by a backslash
// escape (\&) or by decoding a numeric reference (&#38;). A raw '&' in the
// source is left alone when it forms an entity, but one produced by an
// escape or a decode is a real ampersand. Private-use code point, so it
// can never appear in markdown input.
const AMP = '\uE000';

function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isAsciiPunct(ch) {
  // Backslash escapes only apply to ASCII punctuation. A non-ASCII
  // punctuation mark such as « is NOT escapable: the backslash stays.
  return ch.charCodeAt(0) < 128 && ASCII_PUNCT.has(ch);
}

function isPunctCh(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 ? ASCII_PUNCT.has(ch) : UNICODE_PUNCT.test(ch);
}

function isAlnumCh(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
  return UNICODE_ALNUM.test(ch);
}

// Unicode whitespace: space, tab, newline and friends, plus NBSP and the rest.
function isWsCh(ch) {
  const code = ch.charCodeAt(0);
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return /\s/u.test(ch);
}

// HTML escape for the strict contexts (code spans, autolink hrefs): &,
// <, >, " and ' all get escaped, and so does the AMP sentinel.
const STRICT_ESCAPES = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;', 0xE000: '&amp;' };
function escapeHtml(s) {
  let out = '';
  let kept = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = STRICT_ESCAPES[s.charCodeAt(i)];
    if (rep === undefined) continue;
    out += s.slice(kept, i) + rep;
    kept = i + 1;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

// HTML escape for running text, link titles, fence info strings and hrefs:
// <, >, " and ' are escaped, and & is escaped only when it is NOT already
// part of an entity reference (&word; / &#123; / &#xAB;). A valid entity in
// the source is left exactly as written; a bare & becomes &amp;.
const ENTITY_TAIL = /^(?:#[0-9]{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]*);/;
function escapeHtmlLoose(s) {
  let out = '';
  let kept = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    let rep;
    if (code === 38) {
      if (ENTITY_TAIL.test(s.slice(i + 1))) continue;
      rep = '&amp;';
    } else {
      rep = STRICT_ESCAPES[code];
      if (rep === undefined) continue;
    }
    out += s.slice(kept, i) + rep;
    kept = i + 1;
  }
  return kept === 0 ? s : out + s.slice(kept);
}

// A link destination for an href="..." attribute: percent-encode the way
// encodeURI does, then escape loosely. encodeURI leaves %, ', #, &, ;, /,
// ?, :, @, =, +, $, -, _, ., !, ~, *, (, ) alone and encodes spaces,
// non-ASCII and the rest. An AMP sentinel becomes &amp; (a literal '&').
function cleanHref(dest) {
  // Encode one chunk, but keep an existing valid %XX escape as-is
  // (encodeURI would double-encode the '%' into %25). A bare '%' that is
  // not part of a valid %XX escape stays a literal '%' as well, so the
  // %25 that encodeURI produces for it is reverted.
  const encodeChunk = (chunk) => {
    return chunk.split(/(%[0-9A-Fa-f]{2})/g).map((seg) => {
      if (/^%[0-9A-Fa-f]{2}$/.test(seg)) return seg;
      try { return encodeURI(seg).replace(/%25/g, '%'); } catch (e) { return seg; /* lone surrogate: keep raw */ }
    }).join('');
  };
  return escapeHtmlLoose(dest.split(AMP).map(encodeChunk).join('&amp;'));
}

// Decode a numeric character reference starting at s[i] == '&'.
// Returns [decodedChar, lengthConsumed], or null when it is not a
// reference. Named references are NOT decoded here at all: marked leaves
// them as literal text.
function decodeNumericEntity(s, i) {
  // s[i] == '&', s[i + 1] == '#'.
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const firstDigit = j;
  let code = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    let digit = -1;
    if (c >= 48 && c <= 57) digit = c - 48;
    else if (hex && c >= 97 && c <= 102) digit = c - 87;
    else if (hex && c >= 65 && c <= 70) digit = c - 55;
    else break;
    if (code < 0x110000) code = code * (hex ? 16 : 10) + digit;
    else code = 0x110000;
    j++;
  }
  const digits = j - firstDigit;
  if (digits === 0 || j >= s.length || s[j] !== ';') return null;
  // A numeric reference has at most 7 decimal or 6 hexadecimal digits;
  // anything longer is not a reference at all and stays literal text.
  if ((!hex && digits > 7) || (hex && digits > 6)) return null;
  if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) code = 0xFFFD;
  return [String.fromCodePoint(code), j - i + 1];
}

// Normalize a link label for definition lookup: collapse every run of
// whitespace to one space, trim, fold case, and fold ß/ẞ to "ss".
// Labels are compared in RAW form otherwise: backslash escapes, emphasis
// marks and backticks are kept (so `[foo\!]` does not match a `[foo!]:`
// definition, and `[*em*]` matches only a `[*em*]:` definition).
// Labels are at most 999 chars.
function normalizeLabel(raw) {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[ßẞ]/g, 'ss');
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// Node kinds (k): 0 text, 1 code span, 2 delimiter run, 3 em, 4 strong,
// 5 del, 6 link, 7 image, 8 hard break, 9 raw html, 10 open bracket (transient).
// ---------------------------------------------------------------------------

// Flanking of a delimiter run: the characters right before and right after
// the run in the source text. leftFlanking / rightFlanking follow the
// CommonMark rules.
function flanking(s, start, end) {
  const before = start > 0 ? s[start - 1] : '';
  const after = end < s.length ? s[end] : '';
  const beforeWs = before === '' || isWsCh(before);
  const afterWs = after === '' || isWsCh(after);
  const beforePunct = before !== '' && isPunctCh(before);
  const afterPunct = after !== '' && isPunctCh(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return [left, right, before, after];
}

function delimCanOpen(ch, left, right, before, after) {
  if (ch === '_') return left && (!right || isPunctCh(before));
  return left;
}
function delimCanClose(ch, left, right, before, after) {
  if (ch === '_') return right && (!left || isPunctCh(after));
  return right;
}

// Parse one inline string into a node list. `links` is the map of reference
// definitions for the whole document.
// Set when an inline <a> opening tag has been seen without a matching
// </a> (see parseInline); GFM extended autolinks are then off until a
// </a> appears. This is marked's inLink state, kept across blocks within
// one parse() call.
let inLink = false;

function parseInline(s, links) {
  // Once a document contains an inline HTML tag spanning a newline,
  // marked stops recognising GFM extended autolinks (bare email,
  // www., bare scheme URL) for all text after that tag — while
  // <...> autolinks keep working. This flag is reset per parse() call.
  const root = [];
  // Stack of open bracket nodes; each holds its own children list.
  const brackets = [];
  let cur = root;
  const n = s.length;
  let i = 0;

  // Append text to a node list, merging into the trailing text node.
  function pushText(list, txt) {
    if (txt === '') return;
    const last = list[list.length - 1];
    if (last && last.k === 0) last.s += txt;
    else list.push({ k: 0, s: txt });
  }

  // How many spaces trail the text at the end of `list` (counted, not removed).
  function countTrailingSpaces(list) {
    let count = 0;
    for (let x = list.length - 1; x >= 0; x--) {
      const node = list[x];
      if (node.k !== 0) break;
      const m = node.s.match(/ +$/);
      if (!m) break;
      count += m[0].length;
      if (node.s.length > m[0].length) break;
    }
    return count;
  }

  // Remove the trailing spaces from the text at the end of `list`.
  function trimTrailingSpaces(list) {
    let count = 0;
    for (let x = list.length - 1; x >= 0; x--) {
      const node = list[x];
      if (node.k !== 0) break;
      const m = node.s.match(/ +$/);
      if (!m) break;
      count += m[0].length;
      node.s = node.s.slice(0, -m[0].length);
      if (node.s === '') list.pop();
      else break;
    }
    return count;
  }

  // Try to parse a raw HTML tag starting at s[i] == '<'. Returns the raw
  // tag string, or null when this is not a tag (the '<' is then literal
  // text). Tags may span newlines inside attribute values.
  function parseHtmlTag() {
    let j = i + 1;
    if (s[j] === '!') {
      if (s.startsWith('<!--', i)) {
        // `<!-->` and `<!--->` are complete (abruptly closed) comments.
        if (s[i + 4] === '>') return s.slice(i, i + 5);
        if (s[i + 4] === '-' && s[i + 5] === '>') return s.slice(i, i + 6);
        const end = s.indexOf('-->', i + 4);
        if (end === -1) return null;
        return s.slice(i, end + 3);
      }
      if (s.startsWith('[CDATA[', j + 1)) {
        const end = s.indexOf(']]>', j + 8);
        if (end === -1) return null;
        return s.slice(i, end + 3);
      }
      // Declaration <!A ...>: a letter must follow, ends at the next '>'.
      if (j + 1 < n && /[A-Za-z]/.test(s[j + 1])) {
        const end = s.indexOf('>', j + 2);
        if (end === -1) return null;
        return s.slice(i, end + 1);
      }
      return null;
    }
    if (s[j] === '?') {
      const end = s.indexOf('?>', j + 1);
      if (end === -1) return null;
      return s.slice(i, end + 2);
    }
    let k = j;
    let closing = false;
    if (s[k] === '/') { closing = true; k++; }
    if (k >= n || !/[A-Za-z]/.test(s[k])) return null;
    while (k < n && /[A-Za-z0-9-]/.test(s[k])) k++;
    if (closing) {
      // A closing tag takes no attributes: only whitespace, then '>'.
      while (k < n && isSpaceCh(s[k])) k++;
      if (k < n && s[k] === '>') return s.slice(i, k + 1);
      return null;
    }
    // Attributes: each attribute name must be preceded by whitespace,
    // and a self-closing '/' must be followed immediately by '>'.
    for (;;) {
      let hadWs = false;
      while (k < n && isSpaceCh(s[k])) { k++; hadWs = true; }
      if (k >= n) return null;
      if (s[k] === '>') return s.slice(i, k + 1);
      if (s[k] === '/') {
        if (k + 1 < n && s[k + 1] === '>') return s.slice(i, k + 2);
        return null;
      }
      if (!hadWs) return null;
      if (!/[A-Za-z_:]/.test(s[k])) return null;
      while (k < n && /[A-Za-z0-9_.:-]/.test(s[k])) k++;
      // Peek for '=' across whitespace; when there is none, leave the
      // whitespace unconsumed so the next attribute still sees it as
      // its separator (a valueless attribute must not swallow it).
      let peek = k;
      while (peek < n && isSpaceCh(s[peek])) peek++;
      if (peek < n && s[peek] === '=') {
        k = peek + 1;
        while (k < n && isSpaceCh(s[k])) k++;
        if (k >= n) return null;
        const quote = s[k];
        if (quote === '"' || quote === "'") {
          k++;
          while (k < n && s[k] !== quote) k++;
          if (k >= n) return null;
          k++;
        } else {
          if (/["'=<>`]/.test(s[k])) return null;
          while (k < n && !isSpaceCh(s[k]) && s[k] !== '>' && s[k] !== '"' && s[k] !== "'" && s[k] !== '=' && s[k] !== '<' && s[k] !== '`') k++;
          if (k >= n) return null;
        }
      }
    }
  }

  // Parse an autolink <...> starting at s[i] == '<'. Returns the node,
  // or null when this is not an autolink.
  function parseBracketAutolink() {
    let j = i + 1;
    while (j < n && s[j] !== '>' && s[j] !== ' ' && s[j] !== '\n' && s[j] !== '<') j++;
    if (j >= n || s[j] !== '>') return null;
    const inner = s.slice(i + 1, j);
    if (inner === '') return null;
    // Email: local@domain with a dot in the domain.
    const at = inner.lastIndexOf('@');
    if (at > 0) {
      const local = inner.slice(0, at);
      const domain = inner.slice(at + 1);
      if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local) && isValidDomain(domain, true)) {
        return { k: 6, href: 'mailto:' + inner, title: '', ch: [{ k: 0, s: inner }], auto: true };
      }
    }
    // Absolute URI: scheme (2-32 chars) ':' then anything without spaces.
    const m = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(inner);
    if (m) {
      const rest = inner.slice(m[0].length);
      if (rest !== '' && !/[\x00-\x20<>]/.test(rest)) {
        return { k: 6, href: inner, title: '', ch: [{ k: 0, s: inner }], auto: true };
      }
    }
    return null;
  }

  // A domain is labels of letters/digits/hyphens separated by dots, each
  // label not starting or ending with a hyphen. `needDot` requires at
  // least one dot.
  function isValidDomain(domain, needDot) {
    if (domain === '') return false;
    const labels = domain.split('.');
    if (needDot && labels.length < 2) return false;
    for (const lab of labels) {
      if (lab === '' || lab.length > 63) return false;
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
    }
    return true;
  }

  // GFM extended autolink at s[i]: www., scheme:, or bare email. The caller
  // has checked the preceding character. Returns {node, len} or null.
  function parseExtendedAutolink() {
    const rest = s.slice(i);
    // www. + domain (+ :port) (+ path or other trailing text). Marked's
    // `url` takes everything up to a space or '<' after the domain, so
    // `www.flux.com?!\\` links the `?!\\` too (the backpedal keeps it);
    // the tail-trim below drops only what truly ends the URL.
    if (rest.startsWith('www.')) {
      const m = /^www\.([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)([^\s<>]*)/.exec(rest);
      if (m) {
        let url = m[0];
        url = trimAutolinkTail(url);
        if (url === '') return null;
        return { node: { k: 6, href: 'http://' + url, title: '', ch: [{ k: 0, s: url }], auto: true }, len: url.length };
      }
      return null;
    }
    // scheme: (domain|email) (+ path) ; scheme://... takes everything.
    const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(rest);
    if (sm) {
      const after = rest.slice(sm[0].length);
      if (after.startsWith('//')) {
        const m = /^\/\/[^\s<>]*/.exec(after);
        if (m) {
          let url = sm[0] + m[0];
          url = trimAutolinkTail(url);
          if (url === '') return null;
          return { node: { k: 6, href: url, title: '', ch: [{ k: 0, s: url }], auto: true }, len: url.length };
        }
        return null;
      }
      // email or domain, then an optional single path segment (no '/').
      // A path segment needs at least one character after the '/'; a
      // bare '/' is literal text, not part of the link.
      const em = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-_]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-_]*[A-Za-z0-9])?)+)(\/[^\s<>\/]+)?/.exec(after);
      if (em) {
        // A '-' right after the email means the address continues but
        // is malformed there, so the whole thing is not a link. A '_'
        // right after it is the same — UNLESS it closes an emphasis
        // run: marked re-lexes `_... install@x.com_` without the
        // closer, so the address ends cleanly there, while a bare
        // trailing `_` (`a.b-c_d@a.b_`, gfm-632) is no link at all.
        // So a '_' after the address only autolinks when an unmatched
        // '_' opener sits in the current list already.
        const nx = after[em[0].length];
        if (nx === '-') return null;
        if (nx === '_') {
          let opener = false;
          for (const nd of cur) {
            if (nd.k === 2 && nd.c === '_' && nd.o) { opener = true; break; }
          }
          if (!opener) return null;
        }
        let url = sm[0] + em[0];
        url = trimAutolinkTail(url);
        if (url === '') return null;
        return { node: { k: 6, href: url, title: '', ch: [{ k: 0, s: url }], auto: true }, len: url.length };
      }
      const dm = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::(\d+))?(\/[^\s<>\/]*)?/.exec(after);
      if (dm) {
        let url = sm[0] + dm[0];
        url = trimAutolinkTail(url);
        if (url === '') return null;
        return { node: { k: 6, href: url, title: '', ch: [{ k: 0, s: url }], auto: true }, len: url.length };
      }
      return null;
    }
    // Bare email: local@domain.tld
    const em = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+)@([A-Za-z0-9](?:[A-Za-z0-9-_]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-_]*[A-Za-z0-9])?)+)/.exec(rest);
    if (em) {
      // A '-' right after the address means it continues but is
      // malformed there, so the whole thing is not a link. A '_' right
      // after it is the same — UNLESS it closes an emphasis run (see
      // above): only autolink when an unmatched '_' opener sits in the
      // current list already.
      const nx = rest[em[0].length];
      if (nx === '-') return null;
      if (nx === '_') {
        let opener = false;
        for (const nd of cur) {
          if (nd.k === 2 && nd.c === '_' && nd.o) { opener = true; break; }
        }
        if (!opener) return null;
      }
      let url = em[0];
      url = trimAutolinkTail(url);
      if (url === '') return null;
      return { node: { k: 6, href: 'mailto:' + url, title: '', ch: [{ k: 0, s: url }], auto: true }, len: url.length };
    }
    return null;
  }

  // Trim an autolink candidate the way marked's GFM `url` backpedal
  // does: keep normal characters, keep a balanced `(...)` group whole,
  // keep a stray `)` or other punctuation only when more text follows
  // it, and stop before an unbalanced `(` (one with no `)` after it)
  // or before a trailing run of punctuation. A `]` is an ordinary
  // character, so `https://x.io)]` keeps the `)]`.
  function trimAutolinkTail(url) {
    // Stop before &word; (entity-like): the autolink ends before the '&'.
    const ent = url.search(/&[A-Za-z][A-Za-z0-9]*;/);
    if (ent !== -1) url = url.slice(0, ent);
    const n = url.length;
    const punct = `?!.,:;*_'\"~)`;
    let end = 0;
    while (end < n) {
      const c = url[end];
      if (c === '(') {
        // A balanced (...) group is kept whole; an unbalanced '(' ends
        // the URL just before it.
        const close = url.indexOf(')', end + 1);
        if (close === -1) break;
        end = close + 1;
      } else if (c === '&') {
        end++;
      } else if (punct.includes(c)) {
        // Punctuation is kept only when it is not the tail of the URL.
        let j = end;
        while (j < n && punct.includes(url[j])) j++;
        if (j === n) break;
        end = j;
      } else {
        // A run of ordinary characters (anything not punctuation, '('
        // or '&').
        let j = end;
        while (j < n && !punct.includes(url[j]) && url[j] !== '(' && url[j] !== '&') j++;
        end = j;
      }
    }
    return url.slice(0, end);
  }

  // Parse a link destination starting at s[j]. Returns {dest, next} or
  // null. `next` is the index just past the destination.
  function parseDest(j) {
    if (s[j] === '<') {
      let k = j + 1;
      while (k < n && s[k] !== '>' && s[k] !== '\n') {
        if (s[k] === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) k += 2;
        else if (s[k] === '<') return null;
        else k++;
      }
      if (k >= n || s[k] !== '>') return null;
      let dest = '';
      for (let x = j + 1; x < k; x++) {
        if (s[x] === '\\' && x + 1 < k && isAsciiPunct(s[x + 1])) { dest += s[x + 1] === '&' ? AMP : s[x + 1]; x++; }
        else dest += s[x];
      }
      return { dest, next: k + 1 };
    }
    // Bare destination: no spaces or control chars, balanced parens.
    let k = j;
    let parens = 0;
    let dest = '';
    while (k < n) {
      const ch = s[k];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { dest += s[k + 1] === '&' ? AMP : s[k + 1]; k += 2; continue; }
      if (ch === '(') { parens++; dest += ch; k++; continue; }
      if (ch === ')') {
        if (parens === 0) break;
        parens--;
        dest += ch;
        k++;
        continue;
      }
      dest += ch;
      k++;
    }
    if (parens !== 0) return null;
    // An empty destination is allowed when the link closes right away:
    // `[link]()` is a link with an empty href.
    if (dest === '' && s[k] !== ')') return null;
    return { dest, next: k };
  }

  // Parse a link title starting at s[j] (after whitespace). Returns
  // {title, next} or null. The title may span lines; newlines are kept.
  function parseTitle(j) {
    const q = s[j];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const close = q === '(' ? ')' : q;
    let k = j + 1;
    let title = '';
    while (k < n) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { title += s[k + 1] === '&' ? AMP : s[k + 1]; k += 2; continue; }
      if (ch === close) return { title, next: k + 1 };
      if (q === '(' && ch === '(') return null;
      title += ch;
      k++;
    }
    return null;
  }

  // Skip spaces, tabs and newlines from `j` onward.
  function skipInlineWs(j) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return j;
  }

  // The plain text of a node list, used for shortcut/collapsed reference
  // labels: code contributes its content (no backticks), delimiters their
  // literal characters, links their text, images their alt text.
  function plainText(list) {
    let out = '';
    for (const node of list) {
      if (node.k === 0 || node.k === 1 || node.k === 9) out += node.s;
      else if (node.k === 2) out += node.c.repeat(node.n);
      else if (node.k === 3 || node.k === 4 || node.k === 5 || node.k === 6 || node.k === 10) out += plainText(node.ch);
      else if (node.k === 7) out += node.alt;
      else if (node.k === 8) out += ' ';
    }
    // A sentinel AMP is a literal ampersand for label comparison.
    return out.indexOf(AMP) === -1 ? out : out.split(AMP).join('&');
  }

  // Would the innermost open bracket form a link if it closed at the
  // `]` at `closeIdx`? The code-span scanner uses this: a code span must
  // not swallow a `]` that closes a link (the link's text is re-lexed on
  // its own), but it may cross a `]` whose link does not form (cm-342,
  // cm-525, cm-537: the code span forms there instead).
  function bracketLinkAt(closeIdx) {
    if (brackets.length === 0) return false;
    const bracket = brackets[brackets.length - 1];
    if (!bracket.active) return false;
    if (!validLabel(s.slice(bracket.start, closeIdx))) return false;
    const j = closeIdx + 1;
    if (s[j] === '(') {
      // Inline link: '(' + optional ws + dest + optional ws/title + ')'.
      let k = skipInlineWs(j + 1);
      const d = parseDest(k);
      if (!d) return false;
      k = skipInlineWs(d.next);
      if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
        const t = parseTitle(k);
        if (!t) return false;
        k = skipInlineWs(t.next);
      }
      return k < n && s[k] === ')';
    }
    if (s[j] === '[') {
      // Full or collapsed reference: [label] or [].
      let k = j + 1;
      let labelRaw = '';
      let ok = false;
      while (k < n && s[k] !== ']') {
        const ch = s[k];
        if (ch === '[' || ch === '\n') break;
        if (ch === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { labelRaw += s[k] + s[k + 1]; k += 2; continue; }
        labelRaw += ch;
        k++;
      }
      if (k < n && s[k] === ']') ok = true;
      if (!ok) return false;
      const label = labelRaw === '' ? normalizeLabel(s.slice(bracket.start, closeIdx)) : normalizeLabel(labelRaw);
      return label !== '' && labelRaw.length <= 999 && links.has(label);
    }
    // Shortcut reference: the label is the bracket's own content.
    const label = normalizeLabel(s.slice(bracket.start, closeIdx));
    return label !== '' && links.has(label);
  }

  // Try to resolve the bracket on top of the stack at the ']' at s[i].
  // Returns true when a link/image was formed (and i is advanced past what
  // the link consumed); the caller has already consumed the ']'.
  // Does the raw label text (the source between `[` and `]`) match
  // marked's label grammar? A label is a run of: nested bracket pairs
  // (one level deep), backslash escapes, code spans (opener and closer
  // backtick runs need not match; the content holds no backtick), a run
  // of 2+ backticks immediately before the closing `]`, or any single
  // char that is not `[`, `]`, `\` or a backtick. A bare `]` or a
  // backtick that cannot open a code span (or close the label as 2+
  // before `]`) fails the label. Shortcut references use a looser
  // grammar and are NOT checked here.
  function validLabel(t) {
    const n = t.length;
    let p = 0;
    // Scan a bracket pair starting at `start` (t[start] === '['). The
    // pair holds nested pairs (one level), escapes, or plain chars,
    // then ']'. Returns the index just past the ']' or -1.
    const pairEnd = (start) => {
      let q = start + 1;
      while (q < n) {
        const ch = t[q];
        if (ch === '[') {
          // One nested level: escapes or plain chars, then ']'.
          let r = q + 1;
          while (r < n) {
            const c2 = t[r];
            if (c2 === '\\') { if (r + 1 >= n) return -1; r += 2; continue; }
            if (c2 === '[' || c2 === ']') break;
            r++;
          }
          if (r >= n || t[r] !== ']') return -1;
          q = r + 1;
        } else if (ch === '\\') {
          if (q + 1 >= n) return -1;
          q += 2;
        } else if (ch === ']') {
          return q + 1;
        } else {
          q++;
        }
      }
      return -1;
    };
    while (p < n) {
      const ch = t[p];
      if (ch === '[') {
        const end = pairEnd(p);
        if (end < 0) return false;
        p = end;
      } else if (ch === '\\') {
        if (p + 1 >= n) return false;
        p += 2;
      } else if (ch === '`') {
        let run = 0;
        while (p + run < n && t[p + run] === '`') run++;
        // 2+ backticks at the very end of the label sit right before
        // the closing `]` and are allowed as-is.
        if (p + run === n) return run >= 2;
        // Otherwise the run must open a code span: the content runs
        // to the next backtick, which closes it (any run length).
        let q = p + run;
        while (q < n && t[q] !== '`') q++;
        if (q >= n) return false;
        while (q < n && t[q] === '`') q++;
        p = q;
      } else if (ch === ']') {
        return false;
      } else {
        p++;
      }
    }
    return true;
  }

  // Turn every emphasis/strikethrough delimiter run inside `list` (and
  // inside nested brackets) into literal text, so `processEmphasis`
  // never pairs it. Marked hides the delimiters inside a failed
  // inline-link span (`[text](...)` that does not form a link) via its
  // `blockSkip` mask, so `_bar_` inside `[foo _bar_ baz](not a link)`
  // stays literal — but only when a link was actually attempted (a
  // bare `[foo _bar_ baz]` keeps its emphasis). Delimiters inside an
  // already-formed inner link/image are left alone: marked re-lexes a
  // valid link's text on its own, so its emphasis still forms.
  function neutralizeDelims(list) {
    for (let q = 0; q < list.length; q++) {
      const nd = list[q];
      if (nd.k === 2) {
        list[q] = { k: 0, s: nd.c.repeat(nd.n) };
      } else if (nd.k === 10 || nd.k === 3 || nd.k === 4 || nd.k === 5) {
        if (nd.ch) neutralizeDelims(nd.ch);
      }
    }
  }

  function tryCloseBracket(bracket) {
    const parentList = brackets.length > 1 ? brackets[brackets.length - 2].ch : root;
    // The bracket node is the last node of its parent list.
    parentList.pop();
    let j = i + 1; // just past ']'
    let dest = null;
    let title = '';
    let formed = false;
    // Inline links and full/collapsed references need a label that
    // matches marked's label grammar; a bad label means no link forms
    // here at all (the shortcut reference below uses a looser grammar).
    const labelOk = validLabel(s.slice(bracket.start, i));
    // Inline link: '(' immediately after ']'. When it fails (bad
    // destination, bad title, no closing paren), fall through to the
    // shortcut reference instead of failing outright: `[foo](not a link)`
    // with a `[foo]:` definition is a shortcut link plus literal text.
    if (labelOk && s[j] === '(') {
      let k = skipInlineWs(j + 1);
      const d = parseDest(k);
      if (d) {
        k = skipInlineWs(d.next);
        let titleOk = true;
        if (k < n && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
          const t = parseTitle(k);
          if (!t) titleOk = false;
          else { k = skipInlineWs(t.next); title = t.title; }
        }
        if (titleOk && k < n && s[k] === ')') {
          dest = d.dest;
          i = k; // index of ')'
          formed = true;
        }
      }
    }
    if (!formed && labelOk && s[j] === '[') {
      // Full or collapsed reference: [text][label] or [text][].
      let k = j + 1;
      let labelRaw = '';
      let ok = false;
      while (k < n && s[k] !== ']') {
        const ch = s[k];
        if (ch === '[' || ch === '\n') break;
        if (ch === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { labelRaw += s[k] + s[k + 1]; k += 2; continue; }
        labelRaw += ch;
        k++;
      }
      if (k < n && s[k] === ']') ok = true;
      if (!ok) { failBracket(bracket, parentList); return false; }
      // A collapsed reference takes its label from the raw source text of
      // the bracket content (escapes, emphasis and backticks kept).
      const label = labelRaw === '' ? normalizeLabel(s.slice(bracket.start, i)) : normalizeLabel(labelRaw);
      const ref = label === '' ? null : links.get(label);
      if (!ref || labelRaw.length > 999) { failBracket(bracket, parentList); return false; }
      dest = ref.dest;
      title = ref.title;
      i = k; // index of the closing ']' of the label
      formed = true;
    }
    if (!formed) {
      // Shortcut reference: the label is the raw source text of the
      // bracket content (escapes, emphasis and backticks kept).
      const label = normalizeLabel(s.slice(bracket.start, i));
      const ref = label === '' ? null : links.get(label);
      if (!ref) {
        // No link formed at all. If an inline link was attempted
        // (`(` follows `]`), its delimiters stay literal.
        if (s[j] === '(') neutralizeDelims(bracket.ch);
        failBracket(bracket, parentList);
        return false;
      }
      dest = ref.dest;
      title = ref.title;
      formed = true;
    }
    // A link formed: push it into its parent list first, then deactivate
    // every bracket still open (a link's text cannot contain another link).
    // An image does NOT deactivate brackets: an image may sit inside a
    // link, so the outer bracket stays open and `cur` stays in its list.
    const node = bracket.img
      ? { k: 7, src: dest, title, alt: plainText((processEmphasis(bracket.ch), bracket.ch)) }
      : { k: 6, href: dest, title, ch: bracket.ch };
    parentList.push(node);
    brackets.pop();
    if (bracket.img) {
      cur = parentList;
      return true;
    }
    // Deactivate the remaining open link brackets, but keep them on the
    // stack: a later `]` still meets the nearest bracket first, and a
    // deactivated one swallows that `]` as literal text instead of letting
    // it close an outer image. Image brackets stay active.
    for (const b of brackets) {
      if (!b.img) b.active = false;
    }
    // Content still goes into the innermost open bracket (active or not):
    // a deactivated bracket still collects its text until its `]` arrives,
    // so a closing `*` lands inside it and pairs there.
    cur = brackets.length > 0 ? brackets[brackets.length - 1].ch : root;
    return true;
  }

  // A bracket that formed no link: splice it back into its parent list
  // as literal text — the opening `[` (or `![`) plus its children.
  function failBracket(bracket, parentList) {
    pushText(parentList, bracket.img ? '![' : '[');
    for (const child of bracket.ch) parentList.push(child);
    brackets.pop();
    cur = parentList;
  }

  // --- the scan -------------------------------------------------------------
  while (i < n) {
    const ch = s[i];
    // Backslash escapes and hard breaks.
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        cur.push({ k: 8 });
        i += 2;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        pushText(cur, nx === '&' ? AMP : nx);
        i += 2;
        continue;
      }
      pushText(cur, '\\');
      i++;
      continue;
    }
    // Code span.
    if (ch === '`') {
      let run = 0;
      while (i + run < n && s[i + run] === '`') run++;
      let k = i + run;
      let found = -1;
      while (k < n) {
        // A `]` that closes a link-forming bracket stops the scan: the
        // code span must not swallow it (the link's text is re-lexed on
        // its own, so the backticks stay literal there). A `]` whose
        // link does not form is crossed normally.
        if (s[k] === ']' && bracketLinkAt(k)) break;
        if (s[k] === '`') {
          let r2 = 0;
          while (k + r2 < n && s[k + r2] === '`') r2++;
          if (r2 === run) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found === -1) {
        pushText(cur, '`'.repeat(run));
        i += run;
        continue;
      }
      let content = s.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && !/^ +$/.test(content)) {
        content = content.slice(1, -1);
      }
      cur.push({ k: 1, s: content });
      i = found + run;
      continue;
    }
    // Line ending: soft break, or hard break after two or more spaces.
    // A single trailing space stays (it is part of the text); only a
    // hard break consumes the spaces.
    if (ch === '\n') {
      const spaces = countTrailingSpaces(cur);
      if (spaces >= 2) {
        trimTrailingSpaces(cur);
        cur.push({ k: 8 });
        i++;
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        pushText(cur, '\n');
        i++;
      }
      continue;
    }
    // Numeric character reference (named ones are left as literal text).
    if (ch === '&' && s[i + 1] === '#') {
      const dec = decodeNumericEntity(s, i);
      if (dec) {
        pushText(cur, dec[0] === '&' ? AMP : dec[0]);
        i += dec[1];
        continue;
      }
      pushText(cur, '&');
      i++;
      continue;
    }
    // Raw HTML tag or <...> autolink.
    if (ch === '<') {
      const tag = parseHtmlTag();
      if (tag !== null) {
        // An inline <a> opening tag enters link state (extended
        // autolinks stop being recognised); </a> leaves it. Other
        // tags do not touch it.
        const lt = tag.toLowerCase();
        // Marked's inLink state: only an `<a` followed by whitespace
        // opens it (its regex is /^<a /i); a bare `<a>` or a
        // self-closing `<a/>` does not.
        if (lt.startsWith('</a') && (lt.length === 4 || lt[4] === ' ' || lt[4] === '\t' || lt[4] === '\n' || lt[4] === '>')) inLink = false;
        else if (lt.startsWith('<a') && (lt[2] === ' ' || lt[2] === '\t' || lt[2] === '\n')) inLink = true;
        cur.push({ k: 9, s: tag });
        i += tag.length;
        continue;
      }
      const auto = parseBracketAutolink();
      if (auto) {
        cur.push(auto);
        i += auto.ch[0].s.length + 2;
        continue;
      }
      pushText(cur, '&lt;');
      i++;
      continue;
    }
    // Image / link opener. `start` is the source index where the bracket
    // content begins, so the shortcut/collapsed label can be taken from
    // the raw source (escapes, emphasis marks and backticks kept).
    if (ch === '!' && s[i + 1] === '[') {
      const b = { k: 10, ch: [], img: true, active: true, start: i + 2 };
      cur.push(b);
      brackets.push(b);
      cur = b.ch;
      i += 2;
      continue;
    }
    if (ch === '[') {
      const b = { k: 10, ch: [], img: false, active: true, start: i + 1 };
      cur.push(b);
      brackets.push(b);
      cur = b.ch;
      i++;
      continue;
    }
    if (ch === ']') {
      if (brackets.length > 0) {
        const b = brackets[brackets.length - 1];
        if (!b.active) {
          // A `]` meeting a deactivated bracket is literal text: the
          // bracket is used up (its `[` and content become literal too)
          // and the `]` does not reach an outer bracket. This is what
          // keeps `](uri2)` literal inside `![[[foo](uri1)](uri2)](uri3)`.
          const parentList = brackets.length > 1 ? brackets[brackets.length - 2].ch : root;
          brackets.pop();
          // Replace the bracket node in its parent list (by index: content
          // may have been added to the parent after the bracket opened)
          // with its literal form, then the `]` itself, in place.
          const ix = parentList.indexOf(b);
          const repl = [{ k: 0, s: b.img ? '![' : '[' }, ...b.ch, { k: 0, s: ']' }];
          if (ix !== -1) parentList.splice(ix, 1, ...repl);
          else { pushText(parentList, b.img ? '![' : '['); for (const child of b.ch) parentList.push(child); pushText(parentList, ']'); }
          cur = parentList;
          i++;
          continue;
        }
        if (tryCloseBracket(b)) {
          pushText(cur, ''); // keep the list pointer honest
          i++;
          continue;
        }
        // tryCloseBracket already spliced the bracket back on failure.
        pushText(cur, ']');
        i++;
        continue;
      }
      pushText(cur, ']');
      i++;
      continue;
    }
    // Emphasis / strikethrough delimiter runs.
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && s[i + run] === ch) run++;
      if (ch === '~' && run >= 3) {
        pushText(cur, '~'.repeat(run));
        i += run;
        continue;
      }
      const [left, right, before, after] = flanking(s, i, i + run);
      const node = {
        k: 2, c: ch, n: run, n0: run, pre: 0,
        o: delimCanOpen(ch, left, right, before, after),
        cl: delimCanClose(ch, left, right, before, after),
        // The characters flanking the run in the source. The emphasis
        // scan needs them: `before` for the odd-match guard, `after`
        // to tell whether the run is followed by punctuation.
        before, after,
      };
      cur.push(node);
      i += run;
      continue;
    }
    // GFM extended autolink: www. / scheme: / email, only after start,
    // whitespace or one of (*_~ ( — and, in general, after any character
    // that cannot be part of a word (a `<` left over from a failed
    // `<...>` autolink counts: `<https://foo.bar/baz bim>` still links
    // the bare URL inside it). Not recognised inside a link (<a> tag
    // open), nor inside an active bracket that has no link yet: in
    // `[a https://example.com b](https://x.com)` the bare URL is link
    // text, not an autolink. But it IS recognised inside a deactivated
    // bracket (one that already holds a link, so the outer link cannot
    // form) or a bracket whose content already holds a link: marked
    // gates the autolink only on `inLink`, not on bracket depth, and a
    // failed outer bracket leaves the bare URL as plain text to link.
    if (!inLink && (brackets.length === 0 || !brackets[brackets.length - 1].active || brackets[brackets.length - 1].ch.some((nd) => nd.k === 6 || nd.k === 7)) && (ch === 'w' || ch === 'h' || ch === 'f' || ch === 'm' || ch === 'x' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))) {
      const prev = i === 0 ? '' : s[i - 1];
      if (i === 0 || !((prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') || (prev >= '0' && prev <= '9'))) {
        const ext = parseExtendedAutolink();
        if (ext) {
          cur.push(ext.node);
          i += ext.len;
          continue;
        }
      }
    }
    // Plain text: consume a run up to the next special character. Stop
    // at a word start after start/whitespace/(*_~ so a GFM extended
    // autolink (www., scheme:, email) gets a chance to be recognised
    // instead of being swallowed by the text run.
    let j = i;
    while (j < n) {
      const c = s[j];
      if (c === '\\' || c === '`' || c === '\n' || c === '&' || c === '<' || c === '[' || c === ']' || c === '*' || c === '_' || c === '~' || c === '!') break;
      if (j > i && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
        const pv = s[j - 1];
        if (pv === ' ' || pv === '\t' || pv === '\n' || pv === '*' || pv === '_' || pv === '~' || pv === '(') break;
      }
      j++;
    }
    if (j === i) j = i + 1; // a lone '!' or similar: take one char as text
    pushText(cur, s.slice(i, j));
    i = j;
  }

  // Unclosed brackets become literal text.
  while (brackets.length > 0) {
    const b = brackets.pop();
    const pl = brackets.length > 0 ? brackets[brackets.length - 1].ch : root;
    pl.pop();
    pushText(pl, b.img ? '![' : '[');
    for (const child of b.ch) pl.push(child);
  }

  // Emphasis / strikethrough, per sibling list (marked never pairs a delimiter
  // inside a link with one outside it).
  processEmphasis(root);
  return root;
}

// Resolve emphasis and strikethrough in one sibling list. For each run
// that can open, scan forward through the later runs of the same
// character, keeping a pool the runs add to (open-only) or draw from
// (close-only / both), and pair with the run that empties the pool. The
// outermost pair forms first and its content is then resolved on its own,
// the way marked tokenises the inside of an em/strong/del before moving
// on. Of a run, the part a pair spends stays with the new node: the
// opener's leftover becomes its first child, and the closer's leftover
// splits — the part the pair's raw text covers becomes its last child,
// the rest stays after the node as its own run. A run whose scan finds
// no closer spends one delimiter as literal text and is tried again one
// shorter, the way marked retries a run after a failed attempt. A run
// sitting between two runs of the other emphasis character right after
// the opener is skipped by the scan, as marked's right-delimiter
// pattern skips `__...*...__` / `**..._...**`. Delimiters left over
// stay literal text.
function processEmphasis(list) {
  for (const node of list) {
    if (node.ch) processEmphasis(node.ch);
  }
  const delims = [];
  for (const node of list) if (node.k === 2) delims.push(node);
  if (delims.length === 0) return;

  // Wrap the nodes between `opener` and `closer` in a node of `kind`.
  // `use` delimiters come off each end for the emphasis itself; of the
  // closer's run, `used` delimiters belong to the new node's raw text.
  // Returns the new node. The closer node is left holding the part of
  // its run that falls outside the node (if any), ready to be resumed.
  const wrap = (opener, closer, kind, use, used) => {
    const oi = list.indexOf(opener);
    const ci = list.indexOf(closer);
    const children = list.splice(oi + 1, ci - oi - 1);
    const closeBefore = closer.before;
    const openLeft = opener.n - use;
    const closeIn = used - use;
    const closeOut = closer.n - used;
    const inner = [];
    opener.n = openLeft;
    if (openLeft > 0) {
      // A leftover opener sits at the front of the new node's text, so
      // nothing precedes it: it can open (unless the next character is
      // whitespace) and can no longer close.
      opener.pre = 0;
      opener.before = '';
      opener.o = opener.after !== '' && !isWsCh(opener.after);
      opener.cl = false;
      inner.push(opener);
    }
    inner.push(...children);
    if (closeIn > 0) {
      // The part of the closer's run inside the node sits at the back of
      // its text, so nothing follows it: it can close (unless the
      // previous character is whitespace) and can no longer open.
      inner.push({
        k: 2, c: closer.c, n: closeIn, n0: closeIn, pre: 0,
        o: false, cl: closeBefore !== '' && !isWsCh(closeBefore),
        before: closeBefore, after: '',
      });
    }
    const node = { k: kind, ch: inner };
    // The span opener..closer is now just the two adjacent nodes.
    list.splice(oi, 2, node);
    closer.n = closeOut;
    if (closeOut > 0) {
      // The rest of the closer's run stays after the node. Its
      // predecessor is now one of its own delimiters, so it can open
      // unless the next character is whitespace, and can close when the
      // next character is whitespace or punctuation.
      closer.pre = used;
      closer.before = closer.c;
      closer.o = closer.after === '' || !isWsCh(closer.after);
      closer.cl = closer.after === '' || isWsCh(closer.after) || isPunctCh(closer.after);
      list.splice(oi + 1, 0, closer);
    }
    // The opener and every delimiter that moved inside leave this list.
    // The closer stays in it exactly when it still has delimiters.
    for (let x = delims.length - 1; x >= 0; x--) {
      const d = delims[x];
      if (d === opener || children.includes(d)) delims.splice(x, 1);
      else if (d === closer && closeOut === 0) delims.splice(x, 1);
    }
    return node;
  };

  let li = 0;
  while (li < delims.length) {
    const left = delims[li];
    if (!left.o) { li++; continue; }
    const c = left.c;
    const k = left.n;
    let closer = null;
    let closerIdx = -1;
    let use = 0;
    let kind = 0;
    let used = 0;
    if (c === '~') {
      // Strikethrough pairs only runs of exactly the same length, and
      // has no odd-match rule and no guard flag.
      let pool = k;
      for (let ri = li + 1; ri < delims.length; ri++) {
        const run = delims[ri];
        if (run.c !== '~' || run.n !== k) continue;
        if (!run.o && !run.cl) continue;
        if (run.o && !run.cl) { pool += run.n; continue; }
        pool -= run.n;
        if (pool > 0) continue;
        closer = run;
        closerIdx = ri;
        use = k;
        kind = 5;
        used = k;
        break;
      }
    } else {
      // Em / strong: the pool starts at the opener's length. `flex`
      // collects the lengths of both-way runs the odd-match rule skips.
      // `y` is the opener's length counting delimiters already spent
      // from its front; `o` says some were. The guard `R` is set when
      // the character before the opener is a non-space and the run is
      // followed by punctuation — or, for `*`, preceded by a letter or
      // digit. Under the guard a close-only run gets the odd-match
      // check that both-way runs always get.
      let pool = k;
      let flex = 0;
      const y = k + (left.pre || 0);
      const o = (left.pre || 0) > 0;
      const R = left.before !== '' && !isWsCh(left.before) &&
        ((left.after !== '' && isPunctCh(left.after)) ||
          (c === '*' && isAlnumCh(left.before)));
      // Skip a same-character run that sits between two runs of the
      // other emphasis character right after this opener.
      let skipIdx = -1;
      const opp = c === '*' ? '_' : '*';
      if (delims[li + 1] && delims[li + 1].c === opp && delims[li + 1].n >= 2 &&
          delims[li + 2] && delims[li + 2].c === c &&
          delims[li + 3] && delims[li + 3].c === opp && delims[li + 3].n >= 2) {
        skipIdx = li + 2;
      }
      for (let ri = li + 1; ri < delims.length; ri++) {
        if (ri === skipIdx) continue;
        const run = delims[ri];
        if (run.c !== c) continue;
        const b = run.n;
        if (!run.o && !run.cl) continue;
        if (run.o && !run.cl) { pool += b; continue; }
        if (run.o && run.cl || R) {
          if (o && run.o && run.cl) break;
          if (y % 3 !== 0 && (y + b) % 3 === 0) { flex += b; continue; }
        }
        pool -= b;
        if (pool > 0) continue;
        used = Math.min(b, b + pool + flex);
        use = Math.min(k, used) % 2 === 1 ? 1 : 2;
        kind = use === 1 ? 3 : 4;
        closer = run;
        closerIdx = ri;
        break;
      }
    }
    if (!closer) {
      // No closer: spend one delimiter as literal text and try the
      // shorter run again.
      if (left.n > 1) {
        const at = list.indexOf(left);
        list.splice(at, 0, { k: 0, s: c });
        left.n -= 1;
        left.pre = (left.pre || 0) + 1;
        continue;
      }
      li++;
      continue;
    }
    const afterCloser = delims[closerIdx + 1];
    const node = wrap(left, closer, kind, use, used);
    processEmphasis(node.ch);
    if (closer.n > 0) li = delims.indexOf(closer);
    else li = afterCloser === undefined ? delims.length : delims.indexOf(afterCloser);
  }
}

// Render one inline node list to HTML, appending strings to `out`.
// `full` escapes text strictly (used for autolink text, whose & is literal).
function renderInline(list, out, full) {
  for (const node of list) {
    switch (node.k) {
      case 0: // plain text
        out.push(full ? escapeHtml(node.s) : escapeHtmlLoose(node.s));
        break;
      case 1: // code span
        out.push('<code>', escapeHtml(node.s), '</code>');
        break;
      case 2: // delimiter run left literal
        out.push(node.c.repeat(node.n));
        break;
      case 3: // em
        out.push('<em>');
        renderInline(node.ch, out, full);
        out.push('</em>');
        break;
      case 4: // strong
        out.push('<strong>');
        renderInline(node.ch, out, full);
        out.push('</strong>');
        break;
      case 5: // del
        out.push('<del>');
        renderInline(node.ch, out, full);
        out.push('</del>');
        break;
      case 6: { // link
        const href = node.auto ? escapeHtml(safeEncodeURI(node.href)) : cleanHref(node.href);
        out.push('<a href="', href, '"');
        if (node.title !== '') out.push(' title="', escapeHtmlLoose(node.title), '"');
        out.push('>');
        renderInline(node.ch, out, node.auto === true);
        out.push('</a>');
        break;
      }
      case 7: { // image
        out.push('<img src="', cleanHref(node.src), '" alt="', escapeHtmlLoose(node.alt), '"');
        if (node.title !== '') out.push(' title="', escapeHtmlLoose(node.title), '"');
        out.push('>');
        break;
      }
      case 8: // hard break
        out.push('<br>');
        break;
      case 9: // raw html
        out.push(node.s);
        break;
    }
  }
}

function safeEncodeURI(s) {
  try { return encodeURI(s); } catch (e) { return s; }
}

// Render one inline string to HTML: parse it, then render the nodes.
// Used for headings, paragraphs, table cells and link text inside them.
function inlineHtml(text, links) {
  const out = [];
  renderInline(parseInline(text, links), out, false);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// HTML block tags (type 6): a line that opens one of these starts an HTML
// block that runs until a blank line.
const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));

// Column of character offset `o` in `line` (a tab advances to the next
// multiple of 4).
function colAt(line, o) {
  let column = 0;
  for (let x = 0; x < o; x++) {
    column += line[x] === '\t' ? 4 - (column % 4) : 1;
  }
  return column;
}

// Split a table row / header line into cells on unescaped '|' outside code
// spans. A leading and a trailing pipe make empty cells that are dropped.
function splitTableCells(line) {
  const cells = [];
  let cell = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < n && isAsciiPunct(line[i + 1])) {
      // An escaped pipe is a literal pipe in the cell (the backslash is
      // consumed by the split, so a code span `` `\|` `` sees just `|`).
      // Other escapes are kept for the inline parser to resolve.
      cell += line[i + 1] === '|' ? '|' : line[i] + line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (i + run < n && line[i + run] === '`') run++;
      let k = i + run;
      let close = -1; // index of the matching closer run, or -1 / -2
      while (k < n) {
        // An unescaped pipe inside the would-be span means this run does
        // not protect a cell boundary: the pipe splits the row, so the
        // run is literal text, not a code span (an escaped \| is fine —
        // it is a literal pipe inside the span).
        if (line[k] === '\\' && k + 1 < n && line[k + 1] === '|') { k += 2; continue; }
        if (line[k] === '|') { close = -2; break; }
        if (line[k] === '`') {
          let r2 = 0;
          while (k + r2 < n && line[k + r2] === '`') r2++;
          if (r2 === run) { close = k; break; }
          k += r2;
        } else k++;
      }
      if (close < 0) {
        cell += line.slice(i, i + run);
        i += run;
      } else {
        // Inside a code span, an escaped pipe is still a literal pipe
        // (the backslash only stopped the cell split).
        cell += line.slice(i, close + run).replace(/\\\|/g, '|');
        i = close + run;
      }
      continue;
    }
    if (ch === '|') { cells.push(cell); cell = ''; i++; continue; }
    cell += ch;
    i++;
  }
  cells.push(cell);
  // A leading / trailing pipe yields an empty first / last cell: drop them.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Is the line (from `off`, after up to 3 spaces) a table delimiter row?
// Returns the alignment array, or null.
function tableDelimiter(line, off) {
  let j = off;
  let spaces = 0;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    spaces += line[j] === '\t' ? 4 - (colAt(line, j) % 4) : 1;
    if (spaces > 3) return null;
    j++;
  }
  const parts = line.slice(j).split('|');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (parts.length === 0) return null;
  const align = [];
  for (const part of parts) {
    const m = /^\s*(:?)-+(:?)\s*$/.exec(part);
    if (!m) return null;
    align.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return align;
}

// Parse one link reference definition starting at text[pos] (the '[').
// Returns {dest, title, label, end} — end is the index just past the
// definition's last line (at its '\n' or at the end of the text) — or null.
// A definition spans at most 3 lines.
function parseDefinition(text, pos) {
  let j = pos;
  // Up to 3 spaces before '['.
  let lead = 0;
  while (j < text.length && text[j] === ' ' && lead < 3) { j++; lead++; }
  if (text[j] !== '[') return null;
  j++;
  const labelStart = j;
  while (j < text.length && text[j] !== ']') {
    if (text[j] === '[') return null;
    if (text[j] === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) { j += 2; continue; }
    j++;
  }
  if (j >= text.length || text[j] !== ']') return null;
  const norm = normalizeLabel(text.slice(labelStart, j));
  if (norm === '' || norm.length > 999) return null;
  j++;
  if (text[j] !== ':') return null;
  j++;
  // Whitespace (spaces, tabs, at most one newline) before the destination.
  let newlines = 0;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) {
    if (text[j] === '\n') { newlines++; if (newlines > 1) return null; }
    j++;
  }
  // Destination.
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length && text[k] !== '>' && text[k] !== '\n') {
      if (text[k] === '\\' && k + 1 < text.length && isAsciiPunct(text[k + 1])) k += 2;
      else if (text[k] === '<') return null;
      else k++;
    }
    if (k >= text.length || text[k] !== '>') return null;
    for (let x = j + 1; x < k; x++) {
      if (text[x] === '\\' && x + 1 < k && isAsciiPunct(text[x + 1])) { dest += text[x + 1]; x++; }
      else dest += text[x];
    }
    j = k + 1;
  } else {
    let k = j;
    let parens = 0;
    while (k < text.length) {
      const ch = text[k];
      if (ch === ' ' || ch === '\n' || ch === '\t' || ch.charCodeAt(0) < 32) break;
      if (ch === '\\' && k + 1 < text.length && isAsciiPunct(text[k + 1])) { dest += text[k + 1]; k += 2; continue; }
      if (ch === '(') { parens++; dest += ch; k++; continue; }
      if (ch === ')') {
        if (parens === 0) break;
        parens--;
        dest += ch;
        k++;
        continue;
      }
      dest += ch;
      k++;
    }
    if (dest === '' || parens !== 0) return null;
    j = k;
  }
  // Optional title. It must be separated from the destination by
  // whitespace, may sit on the destination's line or on the next line,
  // and may itself span lines. When a title is attempted but turns out
  // invalid, the definition still stands with just the destination, as
  // long as the would-be title was on the next line; on the same line the
  // whole definition fails.
  const destEnd = j;
  let title = '';
  let end = destEnd;
  let k = j;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  let titleOnNextLine = false;
  if (k < text.length && text[k] === '\n') {
    titleOnNextLine = true;
    k++;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  }
  // The end of the destination's own line (for the dest-only fallback).
  let destLineEnd = destEnd;
  while (destLineEnd < text.length && (text[destLineEnd] === ' ' || text[destLineEnd] === '\t')) destLineEnd++;
  if (k < text.length && (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
    if (k === j) return null; // no whitespace before the title
    const q = text[k];
    const close = q === '(' ? ')' : q;
    let t = k + 1;
    let titleText = '';
    let closed = false;
    while (t < text.length) {
      const ch = text[t];
      if (ch === '\\' && t + 1 < text.length && isAsciiPunct(text[t + 1])) { titleText += text[t + 1] === '&' ? AMP : text[t + 1]; t += 2; continue; }
      if (ch === close) { closed = true; break; }
      if (q === '(' && ch === '(') break;
      titleText += ch;
      t++;
    }
    if (closed) {
      let m = t + 1;
      while (m < text.length && (text[m] === ' ' || text[m] === '\t')) m++;
      if (m >= text.length || text[m] === '\n') {
        title = titleText;
        end = m;
      } else if (titleOnNextLine) {
        end = destLineEnd;
      } else {
        return null;
      }
    } else if (titleOnNextLine) {
      end = destLineEnd;
    } else {
      return null;
    }
  } else if (titleOnNextLine) {
    // The next line holds something that is not a title: the definition is
    // destination-only, ending at its own line.
    end = destLineEnd;
  } else {
    if (k < text.length && text[k] !== '\n') return null;
    end = k;
  }
  return { dest, title, label: norm, end };
}

// Strip leading link reference definitions from a paragraph's lines
// (joined with '\n'). Returns the remaining text. Definitions go into
// `links` (the first one wins for a label).
function stripDefinitions(lines, links) {
  const text = lines.join('\n');
  let pos = 0;
  while (pos < text.length) {
    const def = parseDefinition(text, pos);
    if (!def) break;
    if (!links.has(def.label)) links.set(def.label, { dest: def.dest, title: def.title });
    pos = def.end;
    if (text[pos] === '\n') pos++;
  }
  return text.slice(pos);
}

// Build the block tree for one document. Returns the doc node; `links` is
// filled with the document's reference definitions.
function buildBlocks(src, links) {
  const normalized = src.replace(/\r\n?/g, '\n');
  const endsNL = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsNL) lines.pop();
  const n = lines.length;
  const doc = { t: 'doc', children: [], start: 0, end: n };
  const stack = [doc];
  let i = 0;

  // --- current line state (mutated by the helpers below) ---
  // `i` is the last consumed line; `curLine` is the index of the line
  // currently held in `line` (it may be one ahead of `i` while a consumer
  // peeks at the next line).
  let line = '';
  let off = 0;
  let col = 0;
  let curLine = 0;

  // Load line `idx` into the current-line state.
  function setLine(idx) {
    line = lines[idx];
    off = 0;
    col = 0;
    curLine = idx;
  }

  // Is the rest of the current line (from `o`) only spaces and tabs?
  function blankFrom(o) {
    for (let x = o; x < line.length; x++) {
      const c = line[x];
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }

  // Display columns of the leading whitespace starting at offset `o`
  // (tabs advance to the next multiple of 4).
  function leadingWsCols(o) {
    let cols = 0;
    let x = o;
    while (x < line.length) {
      const ch = line[x];
      if (ch === ' ') { cols++; x++; }
      else if (ch === '\t') { cols += 4 - ((col + cols) % 4); x++; }
      else break;
    }
    return cols;
  }

  // Skip up to `max` columns of spaces/tabs. Returns how many were skipped.
  function skipWs(max) {
    let skipped = 0;
    while (off < line.length && skipped < max) {
      const ch = line[off];
      if (ch === ' ') { off++; col++; skipped++; }
      else if (ch === '\t') {
        const w = 4 - (col % 4);
        if (skipped + w > max) break;
        off++; col += w; skipped += w;
      } else break;
    }
    return skipped;
  }

  // Consume one space after a blockquote '>': a tab counts as one column,
  // leaving the rest of the tab as spaces. The tab is replaced by spaces
  // for its full width so column positions stay correct.
  function consumeOneSpace() {
    if (off >= line.length) return;
    if (line[off] === ' ') { off++; col++; return; }
    if (line[off] === '\t') {
      const w = 4 - (col % 4);
      if (w === 1) { off++; col++; return; }
      line = line.slice(0, off) + ' '.repeat(w) + line.slice(off + 1);
      lines[i] = line;
      off++;
      col++;
    }
  }

  // Consume exactly `need` columns of leading whitespace; false when the
  // line does not have that much indent. A straddling tab leaves spaces
  // behind in its place.
  function consumeIndent(need) {
    while (need > 0 && off < line.length) {
      const ch = line[off];
      if (ch === ' ') { off++; col++; need--; }
      else if (ch === '\t') {
        const w = 4 - (col % 4);
        if (w <= need) { off++; col += w; need -= w; }
        else {
          line = line.slice(0, off) + ' '.repeat(w) + line.slice(off + 1);
          lines[i] = line;
          off += need;
          col += need;
          need = 0;
        }
      } else return false;
    }
    return need === 0;
  }

  // Try to match one open container against the current line. Returns the
  // new offset, or -1 when it does not match.
  function matchContainer(node) {
    if (node.t === 'doc' || node.t === 'list') return off;
    if (node.t === 'quote') {
      // A blank line only stays inside the quote when it carries the `>`
      // marker itself (`>` or `> `); a marker-less blank line closes the
      // quote, so the next `>` line starts a new blockquote.
      const saveOff = off, saveCol = col;
      skipWs(3);
      if (off < line.length && line[off] === '>') {
        const gtOff = off;
        off++;
        col++;
        // Consume one space after the marker. A tab here is the marker's
        // space: expand it on the quote's frame — its column is its
        // distance from the `>` (a tab right after `>` is at column 1
        // and becomes three spaces) — then consume one of the spaces.
        // A tab right after that space is content, not a separator:
        // expand it on the quote's frame too (a tab after `> ` is at
        // column 2 and becomes two spaces), and leave `off` on the
        // first space so the content keeps all of them.
        const expandTabAt = (frameCol) => {
          const w = 4 - (frameCol % 4);
          line = line.slice(0, off) + ' '.repeat(w) + line.slice(off + 1);
          lines[i] = line;
          return w;
        };
        if (off < line.length && line[off] === ' ') {
          off++;
          col++;
        } else if (off < line.length && line[off] === '\t') {
          expandTabAt(off - gtOff);
          off++;
          col++;
        }
        if (off < line.length && line[off] === '\t') {
          expandTabAt(off - gtOff);
        }
        return off;
      }
      off = saveOff;
      col = saveCol;
      return -1;
    }
    if (node.t === 'item') {
      // A blank line stays inside an item that already has content, but
      // it closes an item that is still empty (an empty `-` followed by
      // a blank line is done; the next indented line is a new block).
      // A whitespace-only line must reach the item's content column
      // (which, for a task item, is past the `[ ] ` marker) to stay
      // inside; a shorter one ends the item (an empty line, with no
      // indent at all, always stays inside). The columns are counted
      // without consuming anything, so a lone tab is not turned into
      // spaces that could later join the paragraph.
      if (blankFrom(off)) {
        if (node.children.length === 0) return -1;
        if (off >= line.length) return off;
        let c = col, j = off;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          if (line[j] === ' ') { c++; j++; }
          else { c += 4 - (c % 4); j++; }
        }
        return c >= node.contentCol ? off : -1;
      }
      // The item's own marker line: the content starts at the stored
      // offset (marker + whitespace already consumed when the item was
      // created). Later lines must be indented by the content indent.
      if (curLine === node.firstLine) {
        col = node.contentCol;
        return node.contentOff;
      }
      const saveOff = off, saveCol = col;
      if (consumeIndent(node.ci)) return off;
      off = saveOff;
      col = saveCol;
      return -1;
    }
    if (node.t === 'para') {
      return blankFrom(off) ? -1 : off;
    }
    return off;
  }

  // Pop the stack back to `depth` containers, finalizing what is closed.
  function closeTo(depth) {
    while (stack.length - 1 > depth) {
      const node = stack.pop();
      if (node.t === 'para') finishPara(node);
      else if (node.t === 'item' || node.t === 'list') {
        // The end is the last content line, not the line where the block
        // happened to be closed (at EOF that would swallow the blank
        // lines used to decide whether a list is loose). A block with no
        // children ends on its own opening line.
        const lastChild = node.children[node.children.length - 1];
        node.end = lastChild ? lastChild.end : node.start;
      } else if (node.t === 'quote') {
        // A quote's end includes a trailing marker-only line (`>`),
        // which is part of the quote even though it holds no content.
        node.end = i - 1;
      }
    }
  }

  // Close an open paragraph (a new block that interrupts it starts here).
  function closeOpenPara() {
    const top = stack[stack.length - 1];
    if (top.t === 'para') {
      stack.pop();
      finishPara(top);
    }
  }

  // The innermost open container.
  function parent() { return stack[stack.length - 1]; }

  // Append a node to the innermost open container and stamp its end line.
  function addNode(node) {
    node.end = i;
    parent().children.push(node);
    return node;
  }

  // Finalize a paragraph: strip its definitions, keep the rest as text.
  function finishPara(node) {
    const rest = stripDefinitions(node.lines, links);
    node.text = rest;
    node.lines = null;
  }

  // --- block-start checks (pure, on `line` from `o`) ---

  // Offset after up to 3 columns of leading indent from `o`, or -1 when
  // the indent is more than 3 columns. Nearly every block-start check
  // begins with this.
  function indentAt(o) {
    let j = o;
    let sp = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      sp += line[j] === '\t' ? 4 - (colAt(line, j) % 4) : 1;
      if (sp > 3) return -1;
      j++;
    }
    return j;
  }

  function atxAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length || line[j] !== '#') return null;
    let level = 0;
    while (j + level < line.length && line[j + level] === '#' && level < 7) level++;
    if (level > 6) return null;
    const after = j + level;
    if (after < line.length && line[after] !== ' ' && line[after] !== '\t') return null;
    let start = after;
    while (start < line.length && (line[start] === ' ' || line[start] === '\t')) start++;
    let end = line.length;
    while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    if (end > start && line[end - 1] === '#') {
      let k = end - 1;
      while (k > start && line[k - 1] === '#') k--;
      // The closing run may be the whole text (k == start): it is still a
      // closing sequence when the character before it is a space or tab.
      if (k >= start && k > 0 && (line[k - 1] === ' ' || line[k - 1] === '\t')) end = k - 1;
      while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
    }
    return { level, text: line.slice(start, end) };
  }

  function fenceAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length || (line[j] !== '`' && line[j] !== '~')) return null;
    const ch = line[j];
    let len = 0;
    while (j + len < line.length && line[j + len] === ch) len++;
    if (len < 3) return null;
    const info = line.slice(j + len).trim();
    if (ch === '`' && info.includes('`')) return null;
    return { ch, len, info, indent: indentCols(o) };
  }

  // Columns of indent from `o` (the same walk as indentAt, but it returns
  // the count instead of the offset).
  function indentCols(o) {
    let j = o;
    let sp = 0;
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      sp += line[j] === '\t' ? 4 - (colAt(line, j) % 4) : 1;
      j++;
    }
    return sp;
  }

  function htmlStartAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length || line[j] !== '<') return 0;
    const rest = line.slice(j + 1);
    if (/^(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return 1;
    if (rest.startsWith('!--')) return 2;
    if (rest.startsWith('?')) return 3;
    // Type 4 is a declaration: `<!` followed by an uppercase letter.
    if (rest.startsWith('!') && rest.length > 1 && rest[1] >= 'A' && rest[1] <= 'Z') return 4;
    if (rest.startsWith('![CDATA[')) return 5;
    const m = /^(?:\/?)([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(rest);
    if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
    return 0;
  }
  // Validate a tag on one line (rest = text after '<'): a closing tag
  // takes no attributes; an opening tag's attributes must each be
  // preceded by whitespace, and a self-closing '/' must be followed
  // immediately by '>'. Returns true when the tag is valid, or when it
  // is incomplete but so far valid (it may span lines).
  function validTagOnLine(rest) {
    let k = 0;
    let closing = false;
    if (rest[k] === '/') { closing = true; k++; }
    if (k >= rest.length || !/[A-Za-z]/.test(rest[k])) return false;
    while (k < rest.length && /[A-Za-z0-9-]/.test(rest[k])) k++;
    if (closing) {
      while (k < rest.length && isSpaceCh(rest[k])) k++;
      return k >= rest.length || rest[k] === '>';
    }
    for (;;) {
      let hadWs = false;
      while (k < rest.length && isSpaceCh(rest[k])) { k++; hadWs = true; }
      if (k >= rest.length) return true;
      if (rest[k] === '>') return true;
      if (rest[k] === '/') {
        if (k + 1 >= rest.length) return true;
        return rest[k + 1] === '>';
      }
      if (!hadWs) return false;
      if (!/[A-Za-z_:]/.test(rest[k])) return false;
      while (k < rest.length && /[A-Za-z0-9_.:-]/.test(rest[k])) k++;
      // Peek for '=' across whitespace; when there is none, leave the
      // whitespace unconsumed so the next attribute still sees it.
      let peek = k;
      while (peek < rest.length && isSpaceCh(rest[peek])) peek++;
      if (peek < rest.length && rest[peek] === '=') {
        k = peek + 1;
        while (k < rest.length && isSpaceCh(rest[k])) k++;
        if (k >= rest.length) return true;
        const quote = rest[k];
        if (quote === '"' || quote === "'") {
          k++;
          while (k < rest.length && rest[k] !== quote) k++;
          if (k >= rest.length) return true;
          k++;
        } else {
          if (/["'=<>`]/.test(rest[k])) return false;
          while (k < rest.length && !isSpaceCh(rest[k]) && rest[k] !== '>' && rest[k] !== '"' && rest[k] !== "'" && rest[k] !== '=' && rest[k] !== '<' && rest[k] !== '`') k++;
          if (k >= rest.length) return true;
        }
      }
    }
  }

  function thematicAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length) return false;
    const ch = line[j];
    if (ch !== '-' && ch !== '_' && ch !== '*') return false;
    let count = 0;
    let k = j;
    while (k < line.length) {
      const c = line[k];
      if (c === ch) { count++; k++; }
      else if (c === ' ' || c === '\t') k++;
      else return false;
    }
    return count >= 3;
  }

  function listMarkerAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length) return null;
    const ch = line[j];
    if (ch === '-' || ch === '+' || ch === '*') {
      const after = j + 1;
      if (after >= line.length || line[after] === ' ' || line[after] === '\t') {
        return { ordered: false, bullet: ch, markerLen: 1, markerCol: colAt(line, j), after };
      }
      return null;
    }
    if (ch >= '0' && ch <= '9') {
      let k = j;
      let num = 0;
      let digits = 0;
      while (k < line.length && line[k] >= '0' && line[k] <= '9' && digits < 10) {
        num = num * 10 + (line.charCodeAt(k) - 48);
        digits++;
        k++;
      }
      if (digits === 0 || digits > 9) return null;
      if (k < line.length && (line[k] === '.' || line[k] === ')')) {
        const delim = line[k];
        const after = k + 1;
        if (after >= line.length || line[after] === ' ' || line[after] === '\t') {
          return { ordered: true, start: num, delim, markerLen: after - j, markerCol: colAt(line, j), after };
        }
      }
      return null;
    }
    return null;
  }

  function setextAt(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length) return 0;
    const ch = line[j];
    if (ch !== '=' && ch !== '-') return 0;
    // The rest of the line must be only that character, then optional
    // trailing whitespace. A space between the marks (like `= =` or
    // `--- -`) is not a setext underline.
    let k = j;
    while (k < line.length && line[k] === ch) k++;
    while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
    if (k < line.length) return 0;
    return ch === '=' ? 1 : 2;
  }
  // Type 7 HTML block: a complete open or close tag, and nothing else
  // on the line. A closing tag takes no attributes; an opening tag's
  // attributes must each be preceded by whitespace; '/' is followed by
  // '>' at once.
  function htmlType7At(o) {
    const j = indentAt(o);
    if (j === -1 || j >= line.length || line[j] !== '<') return false;
    let k = j + 1;
    let closing = false;
    if (line[k] === '/') { closing = true; k++; }
    if (k >= line.length || !/[A-Za-z]/.test(line[k])) return false;
    while (k < line.length && /[A-Za-z0-9-]/.test(line[k])) k++;
    // Only spaces/tabs may follow the tag (and a closing tag).
    const onlyWsToEnd = (from) => {
      let x = from;
      while (x < line.length && (line[x] === ' ' || line[x] === '\t')) x++;
      return x >= line.length;
    };
    if (closing) {
      while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
      if (k >= line.length || line[k] !== '>') return false;
      return onlyWsToEnd(k + 1);
    }
    for (;;) {
      let hadWs = false;
      while (k < line.length && (line[k] === ' ' || line[k] === '\t' || line[k] === '\n')) { k++; hadWs = true; }
      if (k >= line.length) return false;
      if (line[k] === '/') {
        if (k + 1 < line.length && line[k + 1] === '>') return onlyWsToEnd(k + 2);
        return false;
      }
      if (line[k] === '>') return onlyWsToEnd(k + 1);
      if (!hadWs) return false;
      if (!/[A-Za-z_:]/.test(line[k])) return false;
      while (k < line.length && /[A-Za-z0-9_.:-]/.test(line[k])) k++;
      // Peek for '=' across whitespace; when there is none, leave the
      // whitespace unconsumed so the next attribute still sees it.
      let peek = k;
      while (peek < line.length && (line[peek] === ' ' || line[peek] === '\t')) peek++;
      if (peek < line.length && line[peek] === '=') {
        k = peek + 1;
        while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
        if (k >= line.length) return false;
        const quote = line[k];
        if (quote === '"' || quote === "'") {
          k++;
          while (k < line.length && line[k] !== quote) k++;
          if (k >= line.length) return false;
          k++;
        } else {
          if (/["'=<>`]/.test(line[k])) return false;
          while (k < line.length && line[k] !== ' ' && line[k] !== '\t' && line[k] !== '>' && line[k] !== '"' && line[k] !== "'" && line[k] !== '=' && line[k] !== '<' && line[k] !== '`') k++;
          if (k >= line.length) return false;
        }
      }
    }
  }

  // Does the line (from `o`) start a new block that would end a lazy
  // continuation? Headings, fences, HTML blocks, thematic breaks, list
  // items and blockquotes do; setext underlines, table delimiters and
  // indented code do not.
  function startsNewBlock(o) {
    if (atxAt(o) || fenceAt(o) || htmlStartAt(o) > 0 || thematicAt(o) || listMarkerAt(o) || htmlType7At(o)) return true;
    const j = indentAt(o);
    return j !== -1 && j < line.length && line[j] === '>';
  }

  // Does the line start a blockquote here (up to 3 columns of indent)?
  function quoteAt(o) {
    const j = indentAt(o);
    return j !== -1 && j < line.length && line[j] === '>';
  }

  // Match all open containers against the current line; returns the depth
  // (index in `stack` of the last matched container) and leaves `off`/`col`
  // positioned after the matched markers.
  function matchAll() {
    let depth = 0;
    for (let d = 1; d < stack.length; d++) {
      const node = stack[d];
      const res = matchContainer(node);
      if (res === -1) break;
      off = res;
      depth = d;
    }
    return depth;
  }

  // Consume lines for a fenced code block (opening fence already parsed).
  // Returns the code lines. Stops before the closing fence line (which the
  // caller consumes) or before a line that no longer matches the containers.
  // Each content line has up to `indent` columns of leading whitespace
  // stripped (the opening fence's indent).
  function consumeFenced(fenceCh, fenceLen, indent) {
    const content = [];
    // Expand the leading tabs of `s`, which starts at absolute column
    // `startCol`, into spaces. Only the leading run matters: it decides
    // how far the line is indented in its container's frame.
    const expandLead = (s, startCol) => {
      let c = startCol, k = 0, out = '';
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
        if (s[k] === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; }
        else { out += ' '; c++; }
        k++;
      }
      return out + s.slice(k);
    };
    // The fence's opening line, after the containers were matched, is the
    // "previous line" for the first content line (leading tabs expanded).
    let prevM = expandLead(line.slice(off), col);
    // Strip up to `need` columns of leading whitespace from the current
    // line (already positioned after the containers).
    const stripCols = (need) => {
      while (need > 0 && off < line.length) {
        const ch = line[off];
        if (ch === ' ') { off++; col++; need--; }
        else if (ch === '\t') {
          const w = 4 - (col % 4);
          if (w <= need) { off++; col += w; need -= w; }
          else {
            line = line.slice(0, off) + ' '.repeat(w) + line.slice(off + 1);
            lines[i] = line;
            off += need;
            col += need;
            need = 0;
          }
        } else break;
      }
    };
    // Strip up to `indent` leading whitespace characters from a content
    // line (already positioned after the containers). A tab counts as
    // one character here (it is the fence's indent in characters), even
    // though it spans several columns; the column still advances by
    // the tab's full width so later tab expansion stays aligned.
    const stripIndent = () => {
      let k = 0;
      while (k < indent && off < line.length) {
        const ch = line[off];
        if (ch === ' ') { off++; col++; k++; }
        else if (ch === '\t') { const w = 4 - (col % 4); off++; col += w; k++; }
        else break;
      }
    };
    // Does the previous line block a lazy continuation? A line that does
    // not match the containers is a lazy continuation of the fence unless
    // the previous line starts with four or more spaces, or starts a
    // fence, an ATX heading, an HTML block or a thematic break within
    // `allow` leading spaces (the item's content indent minus one, at
    // most three). `s` has its leading tabs already expanded.
    const blocksLazy = (s, allow) => {
      let lead = 0;
      while (lead < s.length && s[lead] === ' ') lead++;
      if (lead >= 4) return true;
      if (lead > allow) return false;
      const rest = s.slice(lead);
      if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
      let h = 0;
      while (h < rest.length && rest[h] === '#' && h < 6) h++;
      if (h > 0 && (h === rest.length || rest[h] === ' ' || rest[h] === '\t')) return true;
      if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) || /^(?:\*[ \t]*){3,}$/.test(rest)) return true;
      if (rest[0] === '<') {
        const r2 = rest.slice(1);
        if (r2.startsWith('!--') || r2.startsWith('?') || r2.startsWith('![CDATA[')) return true;
        if (r2.startsWith('!') && r2.length > 1 && r2[1] >= 'A' && r2[1] <= 'Z') return true;
        let q = r2[0] === '/' ? 1 : 0, nm = '';
        while (q < r2.length && /[A-Za-z0-9-]/.test(r2[q])) { nm += r2[q]; q++; }
        if (nm !== '' && BLOCK_TAGS.has(nm.toLowerCase())) return true;
        if (/^(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(r2)) return true;
      }
      return false;
    };
    // Blank lines are held pending: they only become content when a
    // later line keeps the block alive (a closing fence or a line that
    // matches the containers). A non-blank line that leaves the
    // containers ends the block when it follows a blank line, or when
    // the container it leaves is a blockquote; a line that leaves only
    // a list item's indent is a lazy continuation unless the previous
    // line blocks it (see blocksLazy).
    let pending = [];
    // `i` must rewind to the last committed content line when the block
    // ends early, so the main loop reprocesses the line that ended it.
    let lastContent = i;
    const flushPending = () => { for (const p of pending) content.push(p); pending = []; };
    const endBlock = () => {
      i = lastContent;
      if (content.length > 0 && content[content.length - 1] === '') content.pop();
      return { content, closed: false };
    };
    while (i + 1 < n) {
      const next = i + 1;
      setLine(next);
      const depth = matchAll();
      // The column where the containers end (before the fence indent is
      // stripped): a line only sits inside a container when this is
      // past zero, which decides whether a leading tab is expanded.
      const containerCol = col;
      i = next;
      if (blankFrom(off)) {
        // A whitespace-only line that misses only a list item's indent
        // stays inside the item (and the fence); one that misses a
        // blockquote marker ends the block at once. The line is held
        // pending with the item's remaining indent and the fence's
        // indent stripped, so a 3-space line in a fence indented 2
        // keeps exactly one space. (A blank line's container match only
        // checks the item's indent, it does not consume it, so the
        // indent is still present in `line` here.)
        let itemCol = 0;
        if (depth < stack.length - 1) {
          const firstMissed = stack[depth + 1];
          if (firstMissed.t !== 'item') return endBlock();
          itemCol = firstMissed.contentCol;
        } else {
          for (let d = stack.length - 1; d >= 1; d--) {
            if (stack[d].t === 'item') { itemCol = stack[d].contentCol; break; }
          }
        }
        stripCols(Math.max(0, itemCol - col));
        stripIndent();
        pending.push(line.slice(off));
        continue;
      }
      if (depth < stack.length - 1) {
        const firstMissed = stack[depth + 1];
        if (firstMissed.t === 'quote' || pending.length > 0) return endBlock();
        if (firstMissed.t !== 'item') return endBlock();
        // A line that leaves only a list item's indent is a lazy
        // continuation — unless the previous line blocks it.
        const allow = Math.max(0, Math.min(3, (firstMissed.ci || 0) - 1));
        if (blocksLazy(prevM, allow)) return endBlock();
        flushPending();
        // The line enters the fence with the fence's indent stripped;
        // for the next line's check it counts with the item's content
        // indent removed (as the list-item text would have it).
        const rawLazy = expandLead(line.slice(off), col);
        stripIndent();
        content.push(line.slice(off));
        prevM = rawLazy.slice(firstMissed.ci || 0);
        lastContent = next;
        continue;
      }
      const closing = fenceAt(off);
      if (closing && closing.ch === fenceCh && closing.len >= fenceLen && closing.info === '') {
        flushPending();
        if (content.length > 0 && content[content.length - 1] === '') content.pop();
        return { content, closed: true };
      }
      flushPending();
      // The line after the containers were matched is the previous line
      // for the next content line (before the fence indent is stripped).
      prevM = expandLead(line.slice(off), col);
      stripIndent();
      // A leading tab in the content is expanded to spaces on its
      // absolute column, but only when the line sits inside a container
      // (containerCol > 0): at the top level a leading tab stays a
      // literal tab. The expansion covers tabs after leading spaces
      // too, not just a tab at the very start of the content.
      if (containerCol > 0) {
        let c = col;
        let j = off;
        let hasTab = false;
        while (j < line.length && (line[j] === '\t' || line[j] === ' ')) {
          if (line[j] === '\t') { hasTab = true; break; }
          j++;
        }
        if (hasTab) {
          j = off;
          c = col;
          while (j < line.length && (line[j] === '\t' || line[j] === ' ')) {
            if (line[j] === '\t') {
              const w = 4 - (c % 4);
              line = line.slice(0, j) + ' '.repeat(w) + line.slice(j + 1);
              lines[i] = line;
              j += w;
              c += w;
            } else { j++; c++; }
          }
        }
      }
      content.push(line.slice(off));
      lastContent = next;
    }
    // EOF: pending blanks are content, then the usual trailing drop.
    // `i` already sits on the last line examined; do not rewind.
    flushPending();
    // A fenced code block's last content line is dropped when it is empty,
    // whether the block ends at a closing fence or because a container
    // stopped matching.
    if (content.length > 0 && content[content.length - 1] === '') content.pop();
    return { content, closed: false };
  }
  // Consume lines for an indented code block (the first line is already
  // stripped of its 4-column indent).
  function consumeIndented(first) {
    const content = [first];
    while (i + 1 < n) {
      const next = i + 1;
      setLine(next);
      const depth = matchAll();
      if (depth < stack.length - 1) break;
      if (blankFrom(off)) {
        // A whitespace-only line inside indented code contributes the
        // line with the code indent stripped (so a 6-space line gives
        // 2 spaces of content).
        const saveOff = off, saveCol = col;
        if (consumeIndent(4)) content.push(line.slice(off));
        else { off = saveOff; col = saveCol; content.push(''); }
        i = next;
        continue;
      }
      const saveOff = off, saveCol = col;
      if (consumeIndent(4)) {
        content.push(line.slice(off));
        i = next;
      } else {
        off = saveOff;
        col = saveCol;
        break;
      }
    }
    while (content.length > 0 && content[content.length - 1] === '') content.pop();
    return content;
  }

  // Consume lines for an HTML block. `endRe` ends types 1-5; types 6-7 end
  // at a blank line. Returns the raw lines plus whether the raw text has
  // no trailing newline: the block ended at a blank line, at a container
  // boundary, or right before a blank line.
  function consumeHtml(type) {
    const content = [line.slice(off)];
    let noTrailingNL = false;
    const endFor = [
      null,
      (l) => /<\/(?:script|pre|style|textarea)/i.test(l),
      (l) => l.includes('-->'),
      (l) => l.includes('?>'),
      (l) => l.includes('>'),
      (l) => l.includes(']]>'),
    ][type] || null;
    // The opening line itself may already contain the end marker (a
    // one-line `<style>...</style>` or `<!-- ... -->`): then the block is
    // just that line.
    if (endFor && endFor(content[0])) {
      if (i < n - 1) {
        const saveLine = line, saveOff = off, saveCol = col, saveCur = curLine;
        setLine(i + 1);
        const depth = matchAll();
        if (line.length === off || depth < stack.length - 1) noTrailingNL = true;
        line = saveLine; off = saveOff; col = saveCol; curLine = saveCur;
      }
      return { content, noTrailingNL };
    }
    while (i + 1 < n) {
      const next = i + 1;
      setLine(next);
      const depth = matchAll();
      if (depth < stack.length - 1) break;
      if (type >= 6) {
        if (blankFrom(off)) { noTrailingNL = true; break; }
      }
      const text = line.slice(off);
      content.push(text);
      i = next;
      if (endFor && endFor(text)) break;
    }
    // When the block ends mid-document, its raw text carries a trailing
    // newline only if the following line is not truly empty: marked's
    // `ge()` trims the raw only when the regex captured two or more
    // trailing newlines, which happens exactly when the next line is
    // empty (a whitespace-only line stops the regex's `\n*` after one
    // newline, so the trailing `\n` survives).
    if (!noTrailingNL && i < n - 1) {
      const saveLine = line, saveOff = off, saveCol = col, saveCur = curLine;
      setLine(i + 1);
      const depth = matchAll();
      if (line.length === off || depth < stack.length - 1) noTrailingNL = true;
      line = saveLine; off = saveOff; col = saveCol; curLine = saveCur;
    }
    return { content, noTrailingNL };
  }
  // Consume table rows after the delimiter. Rows run until a blank line
  // or a line that starts a new block. A line holding only spaces ends
  // the table, but a line holding a tab counts as a (whitespace) row:
  // marked turns it into a row of empty cells and keeps swallowing
  // following lines as rows.
  function consumeTableRows() {
    const rows = [];
    const spacesOnly = () => {
      for (let k = off; k < line.length; k++) if (line[k] !== ' ') return false;
      return true;
    };
    while (i + 1 < n) {
      const next = i + 1;
      setLine(next);
      const depth = matchAll();
      if (depth < stack.length - 1) {
        if (spacesOnly()) break;
        if (startsNewBlock(off)) break;
        rows.push(line.slice(off));
        i = next;
        continue;
      }
      if (spacesOnly()) break;
      if (startsNewBlock(off)) break;
      rows.push(line.slice(off));
      i = next;
    }
    return rows;
  }

  // Create a table from the open paragraph `para` and the delimiter at
  // the current line. The paragraph's last line is the header; earlier
  // lines become a paragraph of their own (if any). Returns false when
  // the delimiter's cell count differs from the header's: then it is not
  // a table at all and the line stays paragraph text.
  function makeTable(para, align) {
    const paraLines = para.lines;
    const headerLine = paraLines[paraLines.length - 1];
    const headCells = splitTableCells(headerLine);
    if (headCells.length !== align.length) return false;
    const restLines = paraLines.slice(0, -1);
    // Remove the paragraph node from its parent.
    const par = stack[stack.length - 2];
    const idx = par.children.indexOf(para);
    if (idx !== -1) par.children.splice(idx, 1);
    stack.pop();
    if (restLines.length > 0) {
      const restText = stripDefinitions(restLines, links);
      if (restText.trim() !== '') {
        const p = { t: 'para', lines: null, text: restText, start: para.start, end: para.end - 1 };
        par.children.push(p);
      }
    }
    const rows = consumeTableRows();
    const table = {
      t: 'table', align, header: headCells,
      rows: rows.map((r) => splitTableCells(r)),
      start: para.start, end: i,
    };
    par.children.push(table);
    return true;
  }

  // --- main loop ------------------------------------------------------------
  while (i < n) {
    setLine(i);
    const depth = matchAll();
    const isBlank = blankFrom(off);
    if (isBlank) {
      // A whitespace-only line is a blank line, EXCEPT when it is the
      // content of a blockquote paragraph: `>  ` (marker + spaces)
      // contributes its post-marker spaces to the open paragraph
      // (cm-241: `> foo` + `>  ` gives `foo\n `). A whitespace-only
      // line with no quote marker — e.g. `   ` after a list item —
      // is just a blank line that ends the paragraph (doc-06/12).
      // So the append applies only when the paragraph's parent is a
      // quote. Only a remainder holding a real space joins the
      // paragraph; a line that is only a tab is a blank line.
      const top0 = stack[stack.length - 1];
      const par0 = stack[stack.length - 2];
      if (top0.t === 'para' && par0 && par0.t === 'quote' && off < line.length && depth >= stack.length - 2 && line.slice(off).includes(' ')) {
        let append = false;
        if (i + 1 < n) {
          const saveLine = line, saveOff = off, saveCol = col, saveCur = curLine;
          setLine(i + 1);
          const d2 = matchAll();
          line = saveLine; off = saveOff; col = saveCol; curLine = saveCur;
          // The containers are stack[1..len-2] (the paragraph itself is
          // last); when one of them fails on the next line, this line
          // ends the container.
          if (d2 < stack.length - 2) append = true;
        } else {
          append = stack.length > 2 || !endsNL;
        }
        if (append) {
          top0.lines.push(line.slice(off));
          top0.lastLazy = false;
          top0.end = i;
          i++;
          continue;
        }
      }
      closeTo(depth);
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    if (depth < stack.length - 1) {
      // Some container failed to match.
      if (top.t === 'para') {
        // A line that starts a new block (a thematic break, a heading, a
        // fence, ...) is not a table delimiter, even when it looks like
        // one: `---` after a list item is an <hr>, not a table.
        if (!startsNewBlock(off)) {
          const align = tableDelimiter(line, off);
          const par = stack[stack.length - 2];
          if (align && par && par.t === 'item' && makeTable(top, align)) {
            i++;
            continue;
          }
          // A lazy line of only `=` marks (a setext underline that cannot
          // be one because it does not match the quote) is indented by four
          // spaces when it follows another lazy line inside a blockquote.
          // A lazy line indented by four or more columns loses exactly
          // four columns (the code indent); fewer than four are kept.
          let textOff = off;
          if (leadingWsCols(off) >= 4) {
            const saveOff = off, saveCol = col;
            if (consumeIndent(4)) textOff = off;
            else { off = saveOff; col = saveCol; }
          }
          let text = line.slice(textOff);
          if (/^\s*=+\s*$/.test(text) && top.lastLazy) {
            for (const anc of stack) {
              if (anc.t === 'quote') { text = '    ' + text.replace(/^\s*/, ''); break; }
            }
          }
          top.lines.push(text);
          top.lastLazy = true;
          top.end = i;
          i++;
          continue;
        }
      }
      closeTo(depth);
    }
    // Phase 2: start a new block at the current parent.
    let parentNode = parent();
    // A list only holds items. When the parent is a list and this line is
    // not a list item continuing it, close the list first so the new block
    // becomes a sibling of the list instead of a child of it.
    if (parentNode.t === 'list') {
      const m = listMarkerAt(off);
      // A thematic break takes precedence over a list item: a line like
      // `* * *` is an <hr>, not another item of the list.
      const continues = !!m && m.ordered === parentNode.ordered &&
        (m.ordered ? m.delim === parentNode.delim : m.bullet === parentNode.bullet) &&
        !thematicAt(off);
      if (!continues) {
        const lastChild = parentNode.children[parentNode.children.length - 1];
        parentNode.end = lastChild ? lastChild.end : i - 1;
        stack.pop();
        parentNode = parent();
      }
    }
    // Setext heading / table: only when a paragraph is open.
    if (parentNode.t === 'para') {
      const level = setextAt(off);
      if (level > 0) {
        const paraLines = parentNode.lines;
        // A setext heading's text is the paragraph's text with leading and
        // trailing whitespace stripped.
        const restText = stripDefinitions(paraLines, links).trim();
        stack.pop();
        const par = parent();
        const idx = par.children.indexOf(parentNode);
        if (idx !== -1) par.children.splice(idx, 1);
        if (restText.trim() !== '') {
          par.children.push({ t: 'head', level, text: restText, start: parentNode.start, end: i });
          i++;
          continue;
        }
        // The paragraph was only definitions: no heading. Reprocess this
        // line as a fresh block (do not consume it).
        continue;
      }
      const align = tableDelimiter(line, off);
      if (align) {
        if (makeTable(parentNode, align)) {
          i++;
          continue;
        }
        // Not a table (cell counts differ): the line is paragraph text.
      }
    }
    const fence = fenceAt(off);
    if (fence) {
      closeOpenPara();
      const fenceStartLine = i;
      // Add the node BEFORE consuming: while the fence reads its lines,
      // the item must already count as non-empty, or a blank line inside
      // the fence would close the item and split the block.
      const node = { t: 'code', lang: '', content: '', start: fenceStartLine, end: i };
      addNode(node);
      // A tilde fence never has its indent stripped from the content
      // (the reference only compensates the indent of a backtick fence),
      // so a tilde fence consumes its lines verbatim.
      const res = consumeFenced(fence.ch, fence.len, fence.ch === '~' ? 0 : fence.indent);
      // The info string is its first word, with backslash escapes resolved.
      let lang = fence.info.split(/[\s]/)[0] || '';
      if (lang.indexOf('\\') !== -1) {
        let out = '';
        for (let x = 0; x < lang.length; x++) {
          if (lang[x] === '\\' && x + 1 < lang.length && isAsciiPunct(lang[x + 1])) { out += lang[x + 1] === '&' ? AMP : lang[x + 1]; x++; }
          else out += lang[x];
        }
        lang = out;
      }
      node.lang = lang;
      node.content = res.content.join('\n') + (res.content.length ? '\n' : '');
      node.end = i;
      i++;
      continue;
    }
    const atx = atxAt(off);
    if (atx) {
      closeOpenPara();
      addNode({ t: 'head', level: atx.level, text: atx.text, start: i, end: i });
      i++;
      continue;
    }
    const htmlType = htmlStartAt(off);
    if (htmlType > 0) {
      closeOpenPara();
      const res = consumeHtml(htmlType);
      const content = res.content;
      const node = { t: 'html', raw: '', start: i - content.length + 1, end: i };
      node.raw = content.join('\n') + (res.noTrailingNL ? '' : (i < n - 1 || endsNL ? '\n' : ''));
      addNode(node);
      i++;
      continue;
    }
    if (thematicAt(off)) {
      closeOpenPara();
      addNode({ t: 'hr', start: i, end: i });
      i++;
      continue;
    }
    // Blockquote: open the container and reprocess the line inside it.
    if (quoteAt(off)) {
      closeOpenPara();
      const quote = { t: 'quote', children: [], start: i, end: i };
      parent().children.push(quote);
      stack.push(quote);
      continue;
    }
    const marker = listMarkerAt(off);
    if (marker) {
      const markerEndCol = colAt(line, marker.after);
      // Content indent: columns after the marker, capped at marker width + 1
      // when five or more spaces follow it.
      let contentCol;
      let isEmpty;
      {
        let j = marker.after;
        let c = markerEndCol;
        let ws = 0;
        while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          if (line[j] === ' ') { c++; ws++; j++; }
          else { const w = 4 - (c % 4); c += w; ws += w; j++; }
        }
        const markerWidth = markerEndCol - marker.markerCol;
        isEmpty = j >= line.length;
        if (isEmpty) contentCol = marker.markerCol + markerWidth + 1;
        else if (ws >= 5) contentCol = marker.markerCol + markerWidth + 1;
        else contentCol = c;
      }
      // A list may interrupt a paragraph only as a bullet list, or an
      // ordered list starting at 1 — unless the paragraph sits inside
      // a list item, where a nested ordered list may start at any
      // number. An empty item never interrupts one.
      const inItem = stack.slice(0, -1).some(n => n.t === 'item');
      if (parentNode.t === 'para' && (isEmpty || (marker.ordered && marker.start !== 1 && !inItem))) {
        parentNode.lines.push(line.slice(off));
        parentNode.lastLazy = false;
        parentNode.end = i;
        i++;
        continue;
      }
      // An interrupting list closes the open paragraph first; the list is
      // then a sibling of it (a child of the item that held the paragraph).
      if (parentNode.t === 'para') {
        closeOpenPara();
        parentNode = parent();
      }
      const baseCol = colAt(line, off);
      const ci = contentCol - baseCol;
      // Find or create the list node. When the parent IS the open list
      // being continued, the item goes into that list itself (and the list
      // is already on the stack, so it is not pushed again).
      let list = null;
      let listOnStack = false;
      if (parentNode.t === 'list' && parentNode.ordered === marker.ordered &&
          (marker.ordered ? parentNode.delim === marker.delim : parentNode.bullet === marker.bullet)) {
        list = parentNode;
        listOnStack = true;
      } else {
        const last = parentNode.children[parentNode.children.length - 1];
        if (last && last.t === 'list' && last.ordered === marker.ordered &&
            (marker.ordered ? last.delim === marker.delim : last.bullet === marker.bullet)) {
          list = last;
        } else {
          list = {
            t: 'list', ordered: marker.ordered, start: marker.ordered ? marker.start : 0,
            delim: marker.ordered ? marker.delim : '', bullet: marker.ordered ? '' : marker.bullet,
            children: [], end: i, lineStart: i,
          };
          parentNode.children.push(list);
        }
      }
      list.end = i;
      const item = { t: 'item', children: [], ci, task: null, start: i, end: i, firstLine: i, contentOff: 0, contentCol: 0 };
      list.children.push(item);
      if (!listOnStack) stack.push(list);
      stack.push(item);
      // The item's first line content starts at contentCol: advance the
      // offset there (a tab may leave spaces behind).
      off = marker.after;
      col = markerEndCol;
      while (col < contentCol && off < line.length) {
        const ch = line[off];
        if (ch === ' ') { off++; col++; }
        else if (ch === '\t') {
          const w = 4 - (col % 4);
          if (col + w <= contentCol) { off++; col += w; }
          else {
            const take = contentCol - col;
            line = line.slice(0, off) + ' '.repeat(w) + line.slice(off + 1);
            lines[i] = line;
            off += take;
            col = contentCol;
          }
        } else break;
      }
      // Task list marker: [ ], [x] or [X] at the start of the content,
      // followed by whitespace and then real content on this line.
      const t3 = line.slice(off, off + 3);
      if (t3 === '[ ]' || t3 === '[x]' || t3 === '[X]') {
        let j = off + 3;
        if (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
          let k = j;
          while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
          if (k < line.length) {
            item.task = line[off + 1] !== ' ';
            off = k;
            col = colAt(line, k);
          }
        }
      }
      // Remember where this item's content starts, so the marker line can
      // be reprocessed inside the item.
      item.contentOff = off;
      item.contentCol = col;
      if (item.task !== null) {
        // A task item's content is a paragraph.
        if (!blankFrom(off)) {
          const para = { t: 'para', lines: [line.slice(off)], start: i, end: i, lastLazy: false };
          item.children.push(para);
          stack.push(para);
        }
        i++;
        continue;
      }
      // Otherwise the line is reprocessed inside the new item, so its
      // content is parsed as whatever block it starts (paragraph, quote,
      // heading, fence, nested list, indented code).
      if (blankFrom(off)) {
        i++;
        continue;
      }
      continue;
    }
    // Indented code: only when no paragraph is open.
    if (parentNode.t !== 'para') {
      const saveOff = off, saveCol = col;
      if (consumeIndent(4)) {
        const codeStartLine = i;
        const content = consumeIndented(line.slice(off));
        addNode({ t: 'code', lang: '', content: content.join('\n') + (content.length ? '\n' : ''), start: codeStartLine, end: i });
        i++;
        continue;
      }
      off = saveOff;
      col = saveCol;
    }
    // HTML block type 7: only when no paragraph is open.
    if (parentNode.t !== 'para' && htmlType7At(off)) {
      const res = consumeHtml(7);
      const content = res.content;
      const node = { t: 'html', raw: '', start: i - content.length + 1, end: i };
      node.raw = content.join('\n') + (res.noTrailingNL ? '' : (i < n - 1 || endsNL ? '\n' : ''));
      addNode(node);
      i++;
      continue;
    }
    // Paragraph.
    if (parentNode.t === 'para') {
      // A continuation line inside a list item loses four columns of
      // indent beyond the item's content indent (marked's indented-code
      // compensation): `- a` + `      * c` gives `* c`, not `    * c`.
      // Lines indented by fewer than four extra columns keep their spaces,
      // and so do continuations at the top level or inside a quote.
      const par = stack[stack.length - 2];
      if (par && par.t === 'item' && leadingWsCols(off) >= 4) {
        consumeIndent(4);
      }
      parentNode.lines.push(line.slice(off));
      parentNode.lastLazy = false;
      parentNode.end = i;
    } else {
      const para = { t: 'para', lines: [line.slice(off)], start: i, end: i, lastLazy: false };
      parentNode.children.push(para);
      stack.push(para);
    }
    i++;
  }
  closeTo(0);
  doc.end = n;
  return doc;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// Is there a blank line between line a and line b (exclusive)?
function hasBlankBetween(lines, a, b) {
  for (let x = a + 1; x < b; x++) {
    // A line of only whitespace, or only blockquote markers and
    // whitespace (`>`, `>>`), is a blank line in context: it separates
    // blocks inside the quote just like an empty line does.
    if (/^[ \t>]*$/.test(lines[x])) return true;
  }
  return false;
}

// A list is loose when two of its items are separated by a blank line, or
// when one of its items holds two blocks separated by a blank line.
function listIsLoose(list, lines) {
  // A block's first line: for a list, its first item's line (the list's
  // own `start` is the ordered-list start number, not a line index).
  const firstLineOf = (node) => (node.t === 'list' ? node.lineStart : node.start);
  for (let x = 1; x < list.children.length; x++) {
    const prev = list.children[x - 1];
    const cur = list.children[x];
    if (hasBlankBetween(lines, prev.end, cur.start)) return true;
  }
  for (const item of list.children) {
    for (let x = 1; x < item.children.length; x++) {
      const prev = item.children[x - 1];
      const cur = item.children[x];
      if (hasBlankBetween(lines, prev.end, firstLineOf(cur))) return true;
    }
  }
  return false;
}

// Render the block tree to HTML. `tight` suppresses the <p> wrapper
// (loose lists render their items' paragraphs, tight ones do not).
function renderBlocks(node, out, links, lines, tight) {
  switch (node.t) {
    case 'doc':
      for (const c of node.children) renderBlocks(c, out, links, lines, false);
      break;
    case 'para': {
      // A paragraph that held only link definitions renders nothing.
      if (node.text.trim() === '') break;
      const html = inlineHtml(node.text, links);
      if (tight) out.push(html);
      else out.push('<p>', html, '</p>\n');
      break;
    }
    case 'head':
      out.push('<h', String(node.level), '>', inlineHtml(node.text, links), '</h', String(node.level), '>\n');
      break;
    case 'code': {
      out.push('<pre><code');
      if (node.lang) out.push(' class="language-', escapeHtmlLoose(node.lang), '"');
      out.push('>', escapeHtml(node.content), '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(node.raw);
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of node.children) renderBlocks(c, out, links, lines, false);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const loose = listIsLoose(node, lines);
      if (node.ordered) {
        out.push(node.start === 1 ? '<ol>\n' : '<ol start="' + node.start + '">\n');
      } else {
        out.push('<ul>\n');
      }
      for (const item of node.children) {
        out.push('<li>');
        const first = item.children[0];
        if (item.task !== null) {
          const box = item.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
          if (first && first.t === 'para') {
            if (loose) out.push('<p>');
            out.push(box, ' ', inlineHtml(first.text, links));
            if (loose) out.push('</p>\n');
            for (let x = 1; x < item.children.length; x++) renderBlocks(item.children[x], out, links, lines, false);
          } else {
            out.push(box, ' ');
            for (const c of item.children) renderBlocks(c, out, links, lines, false);
          }
        } else {
          for (const c of item.children) renderBlocks(c, out, links, lines, !loose);
        }
        out.push('</li>\n');
      }
      out.push(node.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'table': {
      const cellTag = (tag, align) => (align ? '<' + tag + ' align="' + align + '">' : '<' + tag + '>');
      out.push('<table>\n<thead>\n<tr>\n');
      for (let x = 0; x < node.header.length; x++) {
        out.push(cellTag('th', node.align[x]));
        out.push(inlineHtml(node.header[x], links), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let x = 0; x < node.header.length; x++) {
            out.push(cellTag('td', node.align[x]));
            out.push(inlineHtml(x < row.length ? row[x] : '', links), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

export function parse(markdown) {
  inLink = false;
  const links = new Map();
  const doc = buildBlocks(markdown, links);
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  renderBlocks(doc, out, links, lines, false);
  return out.join('');
}
