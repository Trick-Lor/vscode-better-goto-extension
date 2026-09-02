/**
 * @file src/motion/search.js
 * @description The / ? n N * # search family: pattern compilation, match collection, stepping with wraparound, and the word-under-cursor seed.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { charClass } = require("../utils/text.js");
const { position } = require("./line.js");

/**
 * SEARCH (pattern.txt). `/pat` scans forward, `?pat` backward, both wrapping at the buffer edge
 * like Vim's default 'wrapscan'. `n` / `N` repeat the LAST pattern, which reaches the parser through
 * ctx.lastSearch -- parseCommand stays pure, the store lives at the picker layer (searchState).
 */
const REGEX_SEARCH  = /^([1-9]\d*)?([/?])([\s\S]*)$/;
const REGEX_REPEAT  = /^([1-9]\d*)?([nN])$/;
// * / # search the word under the cursor (whole word); g* / g# drop the word boundaries.
const REGEX_STAR    = /^([1-9]\d*)?(g?)([*#])$/;

/**
 * Compile a Vim search pattern. Vim patterns are regexes, so try that first; a pattern that is not
 * valid JS regex syntax (an unbalanced "(" while still being typed, a bare "*") falls back to a
 * literal match rather than throwing.
 *
 * @param {string} pattern
 * @param {boolean} wholeWord  wrap in word boundaries (the `*` / `#` motions)
 * @returns {RegExp|null} null for an empty pattern
 */
const searchRegex = (pattern, wholeWord, ctx) => {
  if (pattern === "") return null;
  const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Vim anchors `*` with \< \>, which use 'iskeyword' -- NOT JS's \b, which is hard-wired to
  // [A-Za-z0-9_]. A keyword containing, say, "$" has no \b before it, so \b silently found
  // nothing. Build the boundary from the SAME class charClass uses (a keyword char is one that
  // is neither blank nor a separator), so the anchor matches whatever wordUnderCursor picked up.
  const separators = ctx && ctx.wordSeparators;
  const keyword = separators === undefined
    ? "\\w"
    : `[^\\s${separators.replace(/[\\\]^-]/g, "\\$&")}]`;
  const anchor = (body) => `(?<!${keyword})${body}(?!${keyword})`;
  const source = wholeWord ? anchor(literal) : pattern;
  try {
    return new RegExp(source, "g");
  } catch {
    // not valid regex syntax (a half-typed "(", a bare "*") -- match the text literally instead
    return new RegExp(wholeWord ? anchor(literal) : literal, "g");
  }
};

/**
 * All match positions for `regex` across the document, in document order.
 *
 * @param {object} ctx
 * @param {RegExp} regex
 * @returns {Array<{ line: number, character: number }>}
 */
const searchMatches = (ctx, regex) => {
  const hits = [];
  for (let line = 0; line < ctx.totalLines; line++) {
    const text = ctx.lineText(line);
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
            hits.push({ line, character: m.index });
            if (m.index === regex.lastIndex) regex.lastIndex++; // zero-width match: do not spin
    }
  }
  return hits;
};

/**
 * Step `count` matches from the cursor, wrapping at the buffer edge ('wrapscan'). The cursor's own
 * position is never the answer -- a search always MOVES, as in Vim.
 *
 * @param {object} ctx
 * @param {RegExp|null} regex
 * @param {boolean} backward
 * @param {number} count
 * @returns {{ line: number, character: number } | null}
 */
const searchStep = (ctx, regex, backward, count) => {
  if (!regex) return null;
  const hits = searchMatches(ctx, regex);
  if (hits.length === 0) return null;
  const after = (h) => h.line > ctx.currentLine
        || (h.line === ctx.currentLine && h.character > ctx.currentChar);
  const before = (h) => h.line < ctx.currentLine
        || (h.line === ctx.currentLine && h.character < ctx.currentChar);
    // index of the first hit strictly past the cursor (forward) / last hit before it (backward)
  let index = backward
    ? hits.reduce((acc, h, i) => (before(h) ? i : acc), -1)
    : hits.findIndex(after);
  if (index < 0) index = backward ? hits.length - 1 : 0;          // wrap
  const step = backward ? -1 : 1;
  // the first landing already consumed one count
  const offset = (index + step * (count - 1)) % hits.length;
  return hits[(offset + hits.length) % hits.length];
};

/**
 * The word under the cursor, for the `*` / `#` motions (pattern.txt "search-commands"). Vim scans
 * FORWARD on the line for the first word character when the cursor sits on whitespace.
 *
 * @param {object} ctx
 * @returns {string} "" when the line holds no word character
 */
const wordUnderCursor = (ctx) => {
  const text = ctx.lineText(ctx.currentLine);
  if (text.length === 0) return "";
  // charClass: 0 = blank, 1 = keyword char, 2 = separator
  const cls = (c) => c === undefined ? 0 : charClass(c, ctx.wordSeparators);
  // VS Code lets the caret rest one PAST the last char; Vim's caret is always ON one, so the
  // scan starts from the last char there instead of off the end (B128)
  const from = Math.min(ctx.currentChar, text.length - 1);
  // Vim tries four things in order (pattern.txt:73-79) and takes the FIRST that hits. Rules 1-2
  // look for a KEYWORD; only if the line has none at or after the caret do rules 3-4 fall back to
  // any non-blank run. Without 3-4, a caret parked on punctuation with no keyword after it on the
  // line reported "No word under the cursor" where Vim searches the punctuation itself.
  const grab = (want) => {
    let at = from;
    while (at < text.length && !want(cls(text[at]))) at++;   // rules 1+3 (under) / 2+4 (after)
    if (at >= text.length) return "";
    let start = at;
    while (start > 0 && want(cls(text[start - 1]))) start--;
    let end = at;
    while (end + 1 < text.length && want(cls(text[end + 1]))) end++;
    return text.slice(start, end + 1);
  };
  return grab((c) => c === 1) || grab((c) => c !== 0);
};

/**
 * Resolve every search form (`/pat`, `?pat`, `n`, `N`, `*`, `#`, `g*`, `g#`) to a position target.
 * Returns null when the spec is not a search at all. A search that resolves also reports the
 * pattern it used, so the picker can remember it for a later `n` (see searchState).
 *
 * @param {string} spec
 * @param {object} ctx
 * @returns {object|null}
 */
const searchCommand = (spec, ctx) => {
  // `wholeWord` must travel with the pattern: `*` sets Vim's `\<word\>` form as THE search
  // pattern, so every later `n` stays anchored. Dropping it here silently widened a `*` search
  // into a substring one on the first repeat.
  const found = (hit, pattern, backward, wholeWord, note) => {
    if (!hit) {
      return { kind   : "none", origin : "vim"
                , message: `Pattern not found: ${pattern}` };
    }
    const target = position(hit.line, hit.character, note, "vim");
    target.search = { pattern, backward, wholeWord };  // picker stores this for n / N
    return target;
  };

  const search = spec.match(REGEX_SEARCH);
  if (search) {
    const count    = search[1] ? parseInt(search[1], 10) : 1;
    const backward = search[2] === "?";
    const pattern  = search[3];
    if (pattern === "") {
      return { kind   : "none", origin : "vim"
                , message: `Type the pattern to search ${backward ? "backward" : "forward"}.` };
    }
    const hit = searchStep(ctx, searchRegex(pattern, false, ctx), backward, count);
    return found(hit, pattern, backward, false
            , `Search ${backward ? "backward" : "forward"} for "${pattern}"`);
  }

  const repeat = spec.match(REGEX_REPEAT);
  if (repeat) {
    const last = ctx.lastSearch;
    if (!last || !last.pattern) {
      return { kind: "none", origin: "vim", message: "No previous search pattern." };
    }
    const count = repeat[1] ? parseInt(repeat[1], 10) : 1;
    // N reverses the direction the pattern was entered with
    const backward = repeat[2] === "N" ? !last.backward : last.backward;
    const hit = searchStep(ctx, searchRegex(last.pattern, last.wholeWord, ctx), backward, count);
    // the note reads the ACTUAL direction, not the keystroke: after `?pat`, `n` repeats
    // BACKWARD, so labelling it "Next" contradicted where the caret was about to land.
    return found(hit, last.pattern, last.backward, last.wholeWord
            , `${backward ? "Previous" : "Next"} match of "${last.pattern}"`);
  }

  const star = spec.match(REGEX_STAR);
  if (star) {
    const count    = star[1] ? parseInt(star[1], 10) : 1;
    const loose    = star[2] === "g";   // g* / g# do not anchor on word boundaries
    const backward = star[3] === "#";
    const word     = wordUnderCursor(ctx);
    if (word === "") {
      return { kind: "none", origin: "vim", message: "No word under the cursor." };
    }
    const hit = searchStep(ctx, searchRegex(word, !loose, ctx), backward, count);
    return found(hit, word, backward, !loose
            , `${backward ? "Previous" : "Next"} ${loose ? "match" : "whole word"} "${word}"`);
  }
  return null;
};

module.exports = {
    searchRegex
  , searchMatches
  , searchStep
  , wordUnderCursor
  , searchCommand
};
