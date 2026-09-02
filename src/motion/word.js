/**
 * @file src/motion/word.js
 * @description Word and WORD motions: the span scanner both w/b/e and the text objects read, the f/t character find, and the human-readable descriptions each motion carries into its label.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";
const { charClass, stepCodePoints } = require("../utils/text.js");

/**
 * Human-readable description of a word motion.
 *
 * @param {string} motion   "w" | "b" | "e"
 * @param {number} count
 * @returns {string}
 */
const wordDescription = (motion, count) => {
  if (motion === "e") {
    return count > 1 ? `Forward to the end of word ${count}` : "Forward to the end of the word";
  }
  const direction = motion === "b" ? "Backward" : "Forward";
  return `${direction} ${count} ${count === 1 ? "word" : "words"}`;
};


/**
 * Maximal non-blank spans across the whole document, in order. wordwise splits a span on a
 * character-class change (Vim "word"); otherwise a span is any non-blank run (Vim "WORD").
 *
 * @param {object} ctx
 * @param {boolean} wordwise
 * @returns {Array<{ line: number, start: number, end: number }>}
 */
const scanSpans = (ctx, wordwise) => {
  const separators = ctx.wordSeparators;
  const spans      = [];
  for (let line = 0; line < ctx.totalLines; line++) {
    const text = ctx.lineText(line);
    // Vim counts a truly empty line as a word/WORD (a whitespace-only line does NOT). It is a
    // stop for w/b/W/B and ge/gE; e/E skip it -- spanTarget filters by motion.
    if (text.length === 0) {
            spans.push({ line, start: 0, end: 0, empty: true });
            continue;
    }
    let i = 0;
    while (i < text.length) {
      const startClass = charClass(text[i], separators);
      if (startClass === 0) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < text.length
                && charClass(text[j], separators) !== 0
                && (!wordwise || charClass(text[j], separators) === startClass)) {
        j++;
      }
            spans.push({ line, start: i, end: j - 1 });
            i = j;
    }
  }
  return spans;
};

/**
 * Resolve a WORD / word motion by stepping `count` spans from the cursor. Clamps to the first /
 * last span when the document edge is reached.
 *
 * @param {object} ctx
 * @param {number} startLine
 * @param {number} startCol
 * @param {boolean} wordwise
 * @param {string} direction   "forward" | "backward"
 * @param {string} edge        "start" | "end"
 * @param {number} count
 * @returns {object|null}  { line, character } or null when the document has no spans
 */
const spanTarget = (ctx, startLine, startCol, wordwise, direction, edge, count) => {
  const scanned = scanSpans(ctx, wordwise);
  // e / E (forward to a word END) do not stop on an empty line; w/b/W/B and ge/gE do.
  const spans = (direction === "forward" && edge === "end")
    ? scanned.filter((span) => !span.empty)
    : scanned;
  if (spans.length === 0) return null;
  let line = startLine;
  let col  = startCol;
  const at = (span) => edge === "start" ? span.start : span.end;
  for (let step = 0; step < count; step++) {
    let target = null;
    if (direction === "forward") {
      target = spans.find((span) =>
                span.line > line || (span.line === line && at(span) > col));
    } else {
      for (let k = spans.length - 1; k >= 0; k--) {
        if (spans[k].line < line || (spans[k].line === line && at(spans[k]) < col)) {
          target = spans[k];
          break;
        }
      }
    }
    if (!target) {
      // no span in this direction -> clamp to the buffer edge, never jump the other way
      // (Vim: w/e at EOF land on the last char; b/ge at BOF land at 0,0). Falling back to
      // the last / first span could sit BEHIND / AHEAD of the cursor and reverse the motion.
      if (direction === "forward") {
        line = ctx.totalLines - 1;
        col  = Math.max(0, ctx.lineLength(line) - 1);
      } else {
        line = 0;
        col  = 0;
      }
      break;
    }
    line = target.line;
    col  = at(target);
  }
  return { line, character: col };
};

/**
 * 0-based column of an f/F/t/T target on a line, or null when the char is not found. f/F land on
 * the char, t/T land one short; count picks the nth occurrence from the cursor.
 *
 * @param {string} text
 * @param {number} fromCol
 * @param {string} motion   "f" | "F" | "t" | "T"
 * @param {string} char
 * @param {number} count
 * @returns {number|null}
 */
const findChar = (text, fromCol, motion, char, count) => {
  const forward = motion === "f" || motion === "t";
  const till    = motion === "t" || motion === "T";
  let index = fromCol;
  for (let step = 0; step < count; step++) {
    index = forward ? text.indexOf(char, index + 1)
      : (index - 1 < 0 ? -1 : text.lastIndexOf(char, index - 1));
    if (index < 0) return null;
  }
  // till steps one CODE POINT short, so a neighbouring emoji never leaves the cursor
  // mid-surrogate (B124) -- same rule as the x/X/r one-shots.
  return till ? stepCodePoints(text, index, forward ? -1 : 1) : index;
};

/**
 * Description of an f/F/t/T find-char target.
 *
 * @param {string} motion
 * @param {string} char
 * @param {number} count
 * @returns {string}
 */
const findDescription = (motion, char, count) => {
  const forward = motion === "f" || motion === "t";
  const till    = motion === "t" || motion === "T";
  const where   = till ? (forward ? "till before" : "till after") : "to";
  const nth     = count > 1 ? ` x${count}` : "";
  return `${forward ? "Forward" : "Backward"} ${where} "${char}"${nth}`;
};

/**
 * Description of a WORD (W/B/E) or backward word-end (ge/gE) motion.
 *
 * @param {string} motion
 * @param {number} count
 * @returns {string}
 */
const wordwiseDescription = (motion, count) => {
  // ge / gE carry the count too, so 2ge reads differently from ge -- like the E branch.
  if (motion === "ge") {
    return count > 1 ? `Backward to the end of word ${count}` : "Backward to the end of a word";
  }
  if (motion === "gE") {
    return count > 1 ? `Backward to the end of WORD ${count}` : "Backward to the end of a WORD";
  }
  if (motion === "E") {
    return count > 1 ? `Forward to the end of WORD ${count}` : "Forward to the end of the WORD";
  }
  const direction = motion === "B" ? "Backward" : "Forward";
  return `${direction} ${count} ${count === 1 ? "WORD" : "WORDs"}`;
};

module.exports = {
    wordDescription
  , scanSpans
  , spanTarget
  , findChar
  , findDescription
  , wordwiseDescription
};
