/**
 * @file src/motion/line.js
 * @description Line-granularity motions: blank-line paragraph jumps, viewport landings, the sentence and brace scanners, and the mark-like step targets.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";
const { firstNonBlank } = require("../utils/text.js");

/**
 * First blank (empty) line at or beyond `cursorLine` in `step` direction, else the boundary line.
 *
 * @param {object} ctx
 * @param {number} cursorLine   0-based line to start scanning from
 * @param {number} step   -1 (up) or +1 (down)
 * @returns {number}
 */
const blankLine = (ctx, cursorLine, step) => {
  // Vim's findpar: a blank line counts as a paragraph boundary only AFTER some non-empty content
  // has been seen (did_skip), and the cursor's own line never counts (first). So starting ON a
  // blank, the adjacent blanks and the next paragraph are skipped to the following boundary.
  let didSkip = false;
  let first   = true;
  let edge    = cursorLine;
  for (let line = cursorLine; line >= 0 && line < ctx.totalLines; line += step) {
    if (ctx.lineLength(line) !== 0) didSkip = true;
    else if (!first && didSkip) return line;
    edge  = line;
    first = false;
  }
  return edge;
};

/**
 * A simple computable position target. `origin` is REQUIRED ("vim" | "improvement") -- see
 * logic-classification.md; every call site names its own origin so none is silently missed.
 *
 * @param {number} line       0-based
 * @param {number} character  0-based
 * @param {string} description
 * @param {string} origin     "vim" | "improvement"
 * @returns {object}
 */
const position = (line, character, description, origin) =>
    ({ kind: "position", line, character, description, origin });

/**
 * A LINEWISE motion target (Vim: gg/G/H/M/L/+/-/_, pure j/k, and a bare line address). A plain "go"
 * still lands on the resolved column; an operator (d/c/y/case/indent) acts on the WHOLE lines
 * spanned. `origin` is REQUIRED, same contract as position().
 *
 * @param {number} line       0-based
 * @param {number} character  0-based (the go landing column)
 * @param {string} description
 * @param {string} origin     "vim" | "improvement"
 * @returns {object}
 */
const lineMotion = (line, character, description, origin) =>
    ({ kind: "position", line, character, description, linewise: true, origin });

/**
 * Sentence-start positions: doc start, then each first non-blank after a sentence-ending . ! ?
 * (optionally trailed by ) ] " ') followed by whitespace or end of line.
 *
 * @param {object} ctx
 * @returns {Array<{ line: number, character: number }>}
 */
const sentenceStarts = (ctx) => {
  const starts = [{ line: 0, character: 0 }];
  for (let line = 0; line < ctx.totalLines; line++) {
    const text = ctx.lineText(line);
    // Vim: an empty line is itself a sentence boundary (a paragraph boundary is a sentence
    // boundary) -- `)` / `(` stop ON the empty line, at column 0.
    if (text === "") {
      starts.push({ line, character: 0 });
    }
    // The first non-blank of a paragraph-start line (after an empty line) is also a stop.
    if (line > 0 && ctx.lineText(line - 1) === "" && text !== "") {
      starts.push({ line, character: firstNonBlank(text) });
    }
    for (let i = 0; i < text.length; i++) {
      if (!/[.!?]/.test(text[i])) continue;
      let j = i + 1;
      while (j < text.length && /[)\]"']/.test(text[j])) j++;
      if (j < text.length && !/\s/.test(text[j])) continue;
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (k < text.length) starts.push({ line, character: k });
      else if (line + 1 < ctx.totalLines) {
                // sentence ends at EOL -> it continues at the first NON-BLANK of the next line
                starts.push({ line: line + 1, character: firstNonBlank(ctx.lineText(line + 1)) });
      }
    }
  }
  return starts;
};

/**
 * Section-boundary positions for one brace: doc start, lines whose first character is `brace`
 * (column 0), doc end. The brace is a parameter because `]]`/`[[` use `{` and `][`/`[]` use `}`.
 *
 * @param {object} ctx
 * @param {string} brace   "{" or "}"
 * @returns {Array<{ line: number, character: number }>}
 */
const braceCol0 = (ctx, brace) => {
  // Real brace-at-column-0 lines only. The direction-appropriate BOF/EOF clamp is added by the
  // caller so the opposite-end sentinel can never be picked as a spurious target.
  const starts = [];
  for (let line = 0; line < ctx.totalLines; line++) {
    if (ctx.lineText(line)[0] === brace) starts.push({ line, character: 0 });
  }
  return starts;
};

/**
 * Step `count` boundary marks forward (")" / "]]") or backward ("(" / "[[") from the cursor.
 *
 * @param {Array<{ line: number, character: number }>} marks
 * @param {number} line
 * @param {number} col
 * @param {boolean} forward
 * @param {number} count
 * @returns {object}  { line, character }
 */
const stepMarks = (marks, line, col, forward, count, lineGranular) => {
  let here = { line, character: col };
  for (let step = 0; step < count; step++) {
    const hereLine = here.line;
    const hereChar = here.character;
    // A section boundary is whole-line: Vim's findpar advances at least one line before it can
    // match, so a boundary on the cursor's own line never counts. Sentence marks are char-
    // granular (many per line), so they also compare position within the line.
    const after  = lineGranular
      ? (mark) => mark.line > hereLine
      : (mark) => mark.line > hereLine
                || (mark.line === hereLine && mark.character > hereChar);
    const before = lineGranular
      ? (mark) => mark.line < hereLine
      : (mark) => mark.line < hereLine
                || (mark.line === hereLine && mark.character < hereChar);
    let target = null;
    if (forward) {
      target = marks.find(after) || marks[marks.length - 1];
    } else {
      for (let k = marks.length - 1; k >= 0; k--) {
        if (before(marks[k])) { target = marks[k]; break; }
      }
      target = target || marks[0];
    }
    here = target;
  }
  return here;
};

module.exports = {
    blankLine
  , position
  , lineMotion
  , sentenceStarts
  , braceCol0
  , stepMarks
};
