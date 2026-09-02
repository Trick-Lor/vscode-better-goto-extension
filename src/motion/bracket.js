/**
 * @file src/motion/bracket.js
 * @description The % motion: finds the bracket that closes or opens the one under the cursor, skipping pairs nested inside.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";
/**
 * Next (forward) / previous (backward) UNMATCHED bracket of a pair, scanned from the cursor over
 * the buffer. Forward finds the close that ENDS the current block; backward finds the open that
 * STARTS it. A depth counter skips balanced inner pairs.
 *
 * @param {object} ctx
 * @param {number} line       0-based start line
 * @param {number} char       0-based start column
 * @param {string} open       opening bracket char
 * @param {string} close      closing bracket char
 * @param {boolean} forward   true = scan forward for the unmatched close
 * @returns {{ line: number, character: number } | null}
 */
const unmatchedBracket = (ctx, line, char, open, close, forward) => {
  let depth = 0;
  if (forward) {
    for (let l = line; l < ctx.totalLines; l++) {
      const text = ctx.lineText(l);
      for (let c = l === line ? char + 1 : 0; c < text.length; c++) {
        if (text[c] === open) depth++;
        else if (text[c] === close) {
          if (depth === 0) return { line: l, character: c };
          depth--;
        }
      }
    }
  } else {
    for (let l = line; l >= 0; l--) {
      const text = ctx.lineText(l);
      for (let c = l === line ? char - 1 : text.length - 1; c >= 0; c--) {
        if (text[c] === close) depth++;
        else if (text[c] === open) {
          if (depth === 0) return { line: l, character: c };
          depth--;
        }
      }
    }
  }
  return null;
};

module.exports = {
    unmatchedBracket
};
