/**
 * @file src/motion/text-object.js
 * @description Vim text objects (iw/aw, ib/ab, i"/a", ip/ap, is/as, it/at): each resolves an inclusive span around the cursor.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { charClass } = require("../utils/text.js");
const { TEXTOBJ_PAIRS, TEXTOBJ_QUOTES, REGEX_TEXTOBJ } = require("../constants/patterns.js");
const { TEXTOBJ_NAMES } = require("../constants/labels.js");
const { sentenceStarts } = require("./line.js");
const { unmatchedBracket } = require("./bracket.js");

/**
 * iw / aw / iW / aW -- the run under the cursor on its own line. Vim treats a WHITESPACE run as an
 * object too, so a cursor sitting on spaces selects the spaces. "a" adds the trailing whitespace
 * run, falling back to the leading one when the object already ends the line (motion.txt:553-577).
 * A count extends over that many further runs.
 *
 * @param {string} text
 * @param {number} col
 * @param {boolean} inner
 * @param {boolean} wordwise  true = "word" (splits on class change), false = "WORD"
 * @param {number} count
 * @param {string|undefined} separators
 * @returns {{ start: number, end: number } | null}
 */
const wordObjectSpan = (text, col, inner, wordwise, count, separators) => {
  if (text.length === 0) return null;
  // tokenise the line into alternating blank / non-blank runs; a wordwise pass also splits a
  // non-blank run whenever the character class changes, exactly like scanSpans.
  const runs = [];
  let i = 0;
  while (i < text.length) {
    const cls = charClass(text[i], separators);
    let j = i + 1;
    while (j < text.length
            && (charClass(text[j], separators) === 0) === (cls === 0)
            && (cls === 0 || !wordwise || charClass(text[j], separators) === cls)) {
      j++;
    }
        runs.push({ start: i, end: j - 1, blank: cls === 0 });
        i = j;
  }
  // the caret may rest one past the last char (VS Code); Vim scans from ON the last char (B128)
  const column = Math.min(col, text.length - 1);
  const at = runs.findIndex((r) => column >= r.start && column <= r.end);
  if (at < 0) return null;
  // a count spans that many OBJECTS; for "a" Vim counts the word+space pair as one step
  let last = at;
  // "aw" starting on whitespace takes that whitespace plus the word after it (motion.txt:714-715);
  // absorbing it up front keeps the count stepping below word-aligned.
  if (!inner && runs[at].blank && at + 1 < runs.length) last = at + 1;
  for (let n = 1; n < count; n++) {
    // one OBJECT per step: "a" skips a separating blank run only when one exists -- adjacent
    // class-change runs (`a.b`) have none, so a fixed +2 overshot them (B129)
    let next = last + 1;
    if (!inner && runs[next] && runs[next].blank) next = last + 2;
    if (next >= runs.length) break;
    last = next;
  }
  const span = { start: runs[at].start, end: runs[last].end };
  if (inner) return span;
  if (runs[at].blank) return span; // the blank start already absorbed its word above
  const after = runs[last + 1];
  if (after && after.blank) return { start: span.start, end: after.end };
  const before = runs[at - 1];
  if (before && before.blank) return { start: before.start, end: span.end };
  return span;
};

/**
 * i( / a( and every bracket synonym -- the block AROUND the cursor. `count` steps out that many
 * nesting levels. "i" excludes the brackets; when the inner block is empty the object collapses to
 * nothing, which Vim reports as no object rather than an inverted range.
 *
 * @param {object} ctx
 * @param {number} line
 * @param {number} char
 * @param {string} pair    two chars: open + close
 * @param {boolean} inner
 * @param {number} count
 * @returns {{ start: object, end: object } | null}
 */
const bracketObjectSpan = (ctx, line, char, pair, inner, count) => {
  const [open, close] = pair;
  let from = { line, character: char };
  let openPos = null;
  let closePos = null;
  // motion.txt:632-633 -- "If the cursor is not inside a () block, then find the next '('". Only
  // scanning backward made `i(` before the block on its own line report "no block".
  if (unmatchedBracket(ctx, line, char, open, close, false) === null) {
    const text = ctx.lineText(line);
    const ahead = text.indexOf(open, text[char] === open ? char : char + 1);
    if (ahead >= 0) from = { line, character: ahead };
  }
  for (let n = 0; n < count; n++) {
    // a cursor sitting ON the open bracket is already inside that block; same for the close
    const here = ctx.lineText(from.line)[from.character];
    openPos = here === open && n === 0
      ? { line: from.line, character: from.character }
      : unmatchedBracket(ctx, from.line, from.character, open, close, false);
    if (!openPos) return null;
    closePos = unmatchedBracket(ctx, openPos.line, openPos.character, open, close, true);
    if (!closePos) return null;
    from = { line: openPos.line, character: openPos.character };
  }
  if (!inner) return { start: openPos, end: closePos };
  // inner = strictly between the brackets; step in one char, wrapping to the next line when the
  // open bracket ends its line (Vim's `i{` over a multi-line block).
  const openLineLen = ctx.lineText(openPos.line).length;
  const start = openPos.character + 1 < openLineLen
    ? { line: openPos.line, character: openPos.character + 1 }
    : { line: openPos.line + 1, character: 0 };
  const end = closePos.character > 0
    ? { line: closePos.line, character: closePos.character - 1 }
    : { line     : closePos.line - 1
      , character: Math.max(0, ctx.lineText(closePos.line - 1).length - 1) };
  if (start.line > end.line
    || (start.line === end.line && start.character > end.character)) return null;
  return { start, end };
};

/**
 * i" / a' / i` -- the quoted run on the cursor's line. Vim pairs quotes from the LINE START, so the
 * cursor lands inside the pair whose span contains it (or the next pair that opens after it). "a"
 * keeps the quotes plus the trailing whitespace (motion.txt:685-710).
 *
 * @param {string} text
 * @param {number} col
 * @param {string} quote
 * @param {boolean} inner
 * @returns {{ start: number, end: number } | null}
 */
const quoteObjectSpan = (text, col, quote, inner, count) => {
  const pairs = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== quote) continue;
    // an escaped quote is not a delimiter -- but a BACKSLASH can itself be escaped, so what
    // matters is whether the run of backslashes before it is odd ('quoteescape', :689-690).
    let slashes = 0;
    while (i - 1 - slashes >= 0 && text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) continue;
    if (open < 0) open = i;
    else { pairs.push({ open, close: i }); open = -1; }
  }
  const pair = pairs.find((p) => col <= p.close);
  if (!pair) return null;
  // motion.txt:706-707 -- with a count of 2, `i"` INCLUDES the quotes but takes no extra space
  if (inner && count >= 2) return { start: pair.open, end: pair.close };
  if (inner) return pair.close - pair.open < 2
    ? null
    : { start: pair.open + 1, end: pair.close - 1 };
  let end = pair.close;
  while (end + 1 < text.length && /\s/.test(text[end + 1])) end++;
  // :695-696 -- trailing white space is included, and only when there is NONE does the leading
  // white space come in instead.
  if (end === pair.close) {
    let start = pair.open;
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    return { start, end };
  }
  return { start: pair.open, end };
};

/**
 * ip / ap -- the paragraph around the cursor. A paragraph is a run of lines of ONE kind (all blank
 * or all non-blank); "a" adds the blank run that follows, or the one before when the paragraph
 * already ends the file (motion.txt:589-601).
 *
 * @param {object} ctx
 * @param {number} line
 * @param {boolean} inner
 * @param {number} count
 * @returns {{ top: number, bottom: number }}
 */
const paragraphObjectSpan = (ctx, line, inner, count) => {
  // DELIBERATELY different from the `{` / `}` motions, which use blankLine() and test length 0.
  // Vim defines these two apart: the general |paragraph| (motion.txt:514) says "a blank line
  // (only containing white space) is NOT a paragraph boundary", but ip / ap carry an explicit
  // "Exception: a blank line (only containing white space) is also a paragraph boundary"
  // (:591-592, :598-599). Do not unify these predicates -- the mismatch is the spec.
  const isBlank = (l) => /^\s*$/.test(ctx.lineText(l));
  const kind    = isBlank(line);
  let top = line;
  while (top > 0 && isBlank(top - 1) === kind) top--;
  let bottom = line;
  while (bottom < ctx.totalLines - 1 && isBlank(bottom + 1) === kind) bottom++;

  // Each count step takes ONE more object. For "a" an object is a run PLUS its trailing blanks,
  // so a step there consumes both; doing that inside a shared loop made every `2ap` collapse back
  // to `ap`, because the tail extension below had already been used up by the count loop.
  const extend = (from) => {
    let end = from;
    if (end < ctx.totalLines - 1) {
      const nextKind = isBlank(end + 1);
      end++;
      while (end < ctx.totalLines - 1 && isBlank(end + 1) === nextKind) end++;
    }
    return end;
  };
  for (let n = 1; n < count; n++) {
    bottom = extend(bottom);
    if (!inner) bottom = extend(bottom);   // "a" also swallows that run's trailing blanks
  }
  if (inner) return { top, bottom };
  const tail = extend(bottom);
  if (tail !== bottom) return { top, bottom: tail };
  // nothing after it -- fall back to the blank run BEFORE, as Vim does at the end of the buffer
  let start = top;
  while (start > 0 && isBlank(start - 1) !== kind) start--;
  return { top: start, bottom };
};

/**
 * is / as -- the sentence around the cursor, reusing the sentenceStarts boundary scan that the
 * `(` / `)` motions already use. "a" runs to the start of the following sentence (so the separating
 * whitespace is included), "i" stops at the last non-blank before it (motion.txt:579-588).
 *
 * @param {object} ctx
 * @param {number} line
 * @param {number} col
 * @param {boolean} inner
 * @param {number} count
 * @returns {{ start: object, end: object } | null}
 */
const sentenceObjectSpan = (ctx, line, col, inner, count) => {
  const marks = sentenceStarts(ctx);
  if (marks.length === 0) return null;
  const before = (m) => m.line < line || (m.line === line && m.character <= col);
  let at = -1;
  for (let i = 0; i < marks.length; i++) if (before(marks[i])) at = i;
  if (at < 0) at = 0;
  const startMark = marks[at];
  // a count that reaches past the last sentence start falls off the array, and the !nextMark
  // branch extends to end of buffer -- clamping it made `2as` degenerate to `as` (B130)
  const nextMark  = marks[at + count];
  if (!nextMark) {
    const lastLine = ctx.totalLines - 1;
    return { start: startMark
           , end  : { line     : lastLine
                    , character: Math.max(0, ctx.lineText(lastLine).length - 1) } };
  }
  if (!inner) {
    return { start: startMark
            , end  : nextMark.character > 0
              ? { line: nextMark.line, character: nextMark.character - 1 }
              : { line     : nextMark.line - 1
                    , character: Math.max(0, ctx.lineText(nextMark.line - 1).length - 1) } };
  }
  // inner stops at the last NON-BLANK before the next sentence starts
  let l = nextMark.line;
  let c = nextMark.character - 1;
  while (l >= startMark.line) {
    const text = ctx.lineText(l);
    while (c >= 0 && /\s/.test(text[c])) c--;
    if (c >= 0) break;
    l--;
    if (l >= 0) c = ctx.lineText(l).length - 1;
  }
  if (l < startMark.line) return null;
  return { start: startMark, end: { line: l, character: Math.max(0, c) } };
};

/**
 * it / at -- the HTML / XML tag block around the cursor. Scans the whole document for tags, pairing
 * them with a stack so nesting works; self-closing and void tags are skipped, as Vim does
 * (motion.txt:766-780). "i" is the content between the tags, "a" includes both tags.
 *
 * @param {object} ctx
 * @param {number} line
 * @param {number} col
 * @param {boolean} inner
 * @param {number} count
 * @returns {{ start: object, end: object } | null}
 */
const tagObjectSpan = (ctx, line, col, inner, count) => {
  // flatten the document so one regex pass can find every tag, keeping an offset -> position map
  const starts = [];
  let doc = "";
  for (let l = 0; l < ctx.totalLines; l++) {
        starts.push(doc.length);
        doc += ctx.lineText(l) + "\n";
  }
  const toPos = (offset) => {
    let l = 0;
    while (l + 1 < starts.length && starts[l + 1] <= offset) l++;
    return { line: l, character: offset - starts[l] };
  };
  const cursor = starts[line] + col;
  const open   = [];
  const blocks = [];
  // An attribute VALUE may contain ">", so a tag cannot simply run to the next ">" -- quoted
  // spans are skipped first, otherwise `<a t="x>y">z</a>` ended the tag inside the attribute and
  // produced a range starting mid-attribute.
  const re = /<(\/)?([A-Za-z][-\w]*)((?:"[^"]*"|'[^']*'|[^>'"])*)(\/)?>/g;
  let m;
  while ((m = re.exec(doc)) !== null) {
    if (m[4]) continue;                       // self-closing <br/>
    if (m[1]) {                               // closing tag
      for (let i = open.length - 1; i >= 0; i--) {
        // motion.txt:774 -- "Case is ignored, also for XML where case does matter."
        if (open[i].name.toLowerCase() !== m[2].toLowerCase()) continue;
                blocks.push({ openStart : open[i].start, openEnd   : open[i].end
                    , closeStart: m.index, closeEnd  : m.index + m[0].length - 1 });
                open.length = i;
                break;
      }
    } else {
            open.push({ name: m[2], start: m.index, end: m.index + m[0].length - 1 });
    }
  }
  const around = blocks
    .filter((b) => b.openStart <= cursor && cursor <= b.closeEnd)
    .sort((a, b) => (a.closeEnd - a.openStart) - (b.closeEnd - b.openStart));
    // a count asks for the count'th enclosing block (:654-656); when there is no such level Vim
    // fails rather than handing back the outermost one, so do not clamp the index
  if (count > around.length) return null;
  const block = around[count - 1];
  if (!block) return null;
  if (!inner) return { start: toPos(block.openStart), end: toPos(block.closeEnd) };
  // :772 -- "it" on a tag block with NO contents selects the leading tag instead of failing
  if (block.closeStart - block.openEnd < 2) {
    return { start: toPos(block.openStart), end: toPos(block.openEnd) };
  }
  return { start: toPos(block.openEnd + 1), end: toPos(block.closeStart - 1) };
};

/**
 * Resolve a text-object spec (`iw`, `2a{`, `it` ...) into an INCLUSIVE range target. Returns null
 * when the spec is not a text object at all (so the caller falls through to the other motions), and
 * a { kind: "none" } message when it IS one but no object surrounds the cursor.
 *
 * @param {string} spec
 * @param {object} ctx
 * @returns {object|null}
 */
const textObject = (spec, ctx) => {
  const match = spec.match(REGEX_TEXTOBJ);
  if (!match) return null;
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const inner = match[2] === "i";
  const key   = match[3];
  const line  = ctx.currentLine;
  const col   = ctx.currentChar;
  const kindWord = inner ? "inner" : "a";

  const lineSpan = (span) => span
    ? { kind     : "range", origin   : "vim", inclusive: true
            , start    : { line, character: span.start }, end      : { line, character: span.end }
            , note     : `${kindWord} ${TEXTOBJ_NAMES[key]}` }
    : { kind: "none", origin: "vim", message: `No ${TEXTOBJ_NAMES[key]} under the cursor` };
  const docSpan = (span) => span
    ? { kind     : "range", origin   : "vim", inclusive: true, start    : span.start, end      : span.end
            , note     : `${kindWord} ${TEXTOBJ_NAMES[key]}` }
    : { kind: "none", origin: "vim", message: `No ${TEXTOBJ_NAMES[key]} around the cursor` };

  if (key === "w" || key === "W") {
    return lineSpan(wordObjectSpan(ctx.lineText(line), col, inner, key === "w", count
            , ctx.wordSeparators));
  }
  if (TEXTOBJ_QUOTES.includes(key)) {
    return lineSpan(quoteObjectSpan(ctx.lineText(line), col, key, inner, count));
  }
  if (TEXTOBJ_PAIRS[key]) {
    return docSpan(bracketObjectSpan(ctx, line, col, TEXTOBJ_PAIRS[key], inner, count));
  }
  if (key === "p") {
    const span = paragraphObjectSpan(ctx, line, inner, count);
    // ip / ap are LINEWISE in Vim (motion.txt:589-601). Modelling them as a char range made
    // `dip` on a blank line a silent no-op: the range collapsed to zero width and the delete
    // removed nothing. The linewise flag sends applyRange down the whole-lines path instead.
    const result = docSpan({ start: { line: span.top, character: 0 }
            , end  : { line     : span.bottom
                , character: Math.max(0, ctx.lineText(span.bottom).length - 1) } });
    if (result.kind === "range") result.linewise = true;
    return result;
  }
  if (key === "s") return docSpan(sentenceObjectSpan(ctx, line, col, inner, count));
  if (key === "t") return docSpan(tagObjectSpan(ctx, line, col, inner, count));
  return null;
};

module.exports = {
    wordObjectSpan
  , bracketObjectSpan
  , quoteObjectSpan
  , paragraphObjectSpan
  , sentenceObjectSpan
  , tagObjectSpan
  , textObject
};
