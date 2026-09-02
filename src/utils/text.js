/**
 * @file src/utils/text.js
 * @description Pure text helpers: input normalisation, line-scan positions (first / last
 *   non-blank), Vim word character classes, case transforms, and code-point-safe stepping.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

/**
 * Safety net so a BOTTOM note reads as a proper label -- capitalize its first letter (e.g.
 * "to the end of the line" -> "At the end of the line"). A note starting with a digit is unchanged.
 *
 * @param {string} s
 * @returns {string}
 */
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Strip whitespace -- it is insignificant everywhere. The one verbatim exception lives in
 * normalizeSpec (the caller), not here: the literal char after f / F / t / T, so `f<space>` finds
 * a space. `%` always means percent regardless of spacing, so `50 %` and `50%` both resolve to
 * 50% of the file.
 *
 * @param {string} text   the value after the leading ":" and surrounding spaces are removed
 * @returns {string}
 */
const dropSpaces = (text) => text.replace(/\s+/g, "");

/**
 * Normalise raw box input for the parser, dropping insignificant whitespace while keeping the
 * three spots where a space is data: a search pattern (verbatim from the first / or ?, so
 * `/alpha beta` looks for the phrase -- B108), the literal char after a trailing f / F / t / T,
 * and the replacement char of a standalone r{char} (change.txt:276; never after an operator).
 * Ex commands also contain "/" but never reach here -- parseCommandCore takes the ":" branch first.
 *
 * @param {string} text
 * @returns {string}
 */
const normalizeSpec = (text) => {
  const at = text.search(/[/?]/);
  if (at >= 0) return dropSpaces(text.slice(0, at)) + text.slice(at);
  const find = text.match(/^(.*[fFtT])(\s)$/);
  if (find) return dropSpaces(find[1]) + find[2];
  const replace = text.match(/^(.*r)(\s)$/);
  if (replace && /^([1-9]\d*)?r$/.test(dropSpaces(replace[1]))) {
    return dropSpaces(replace[1]) + replace[2];
  }
  return dropSpaces(text);
};

/**
 * Character class for word scanning: 0 = blank, 1 = word, 2 = punctuation. A word char is
 * non-blank and NOT a separator -- matching VS Code's `editor.wordSeparators` so w/b/e align with
 * the built-in word commands; falls back to \w when no separators are provided.
 *
 * @param {string} ch
 * @param {string|undefined} separators
 * @returns {number}
 */
const charClass = (ch, separators) => /\s/.test(ch) ? 0
  : (separators !== undefined ? !separators.includes(ch) : /\w/.test(ch)) ? 1 : 2;

/**
 * 0-based index of the first non-blank character of a line (0 when the line is blank).
 *
 * @param {string} text
 * @returns {number}
 */
const firstNonBlank = (text) => {
  const index = text.search(/\S/);
  return index < 0 ? 0 : index;
};

/**
 * Where Vim's first-non-blank cursor motions (^, gg, G, H, M, L, +, -, _) land. Same as
 * firstNonBlank on a line with any non-blank char, but on an ALL-WHITESPACE line Vim's beginline()
 * runs its whitespace skip with the BL_FIX flag ("don't leave the cursor on a NUL"), so the cursor
 * stops on the LAST whitespace char, not column 0. Empty line ("") -> 0.
 *
 * @param {string} text
 * @returns {number}
 */
const firstNonBlankLanding = (text) => {
  const index = text.search(/\S/);
  return index < 0 ? Math.max(0, text.length - 1) : index;
};

/**
 * 0-based index of the LAST non-blank character of a line (0 when the line is blank).
 *
 * @param {string} text
 * @returns {number}
 */
const lastNonBlank = (text) => {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length === 0 ? 0 : trimmed.length - 1;
};

/**
 * Swap the case of every letter (1.90 has no toggle-case command, so g~ rewrites manually).
 * Unicode-aware: Vim's ~ / g~ use the locale (change.txt:316), so accented letters toggle too.
 * Only 1:1 mappings apply -- a char whose upper/lower form changes length (sharp-s U+00DF -> SS)
 * stays as-is, matching Vim's one-char towupper/towlower.
 *
 * @param {string} text
 * @returns {string}
 */
const swapCase = (text) => Array.from(text).map((ch) => {
  const upper = ch.toUpperCase();
  if (ch !== upper) return upper.length === ch.length ? upper : ch;
  const lower = ch.toLowerCase();
  return ch !== lower && lower.length === ch.length ? lower : ch;
}).join("");

/**
 * Rot13 every ASCII letter (g? operator, change.txt:361-370); other chars pass through.
 *
 * @param {string} text
 * @returns {string}
 */
const rot13 = (text) => text.replace(/[a-zA-Z]/g, (ch) => {
  const base = ch <= "Z" ? 65 : 97;
  return String.fromCharCode((ch.charCodeAt(0) - base + 13) % 26 + base);
});

/**
 * Step `count` code points forward (positive) or backward (negative) from a UTF-16 offset, so the
 * char one-shots (x / X / r / ~) never split a surrogate pair -- Vim counts characters
 * (change.txt:31), not UTF-16 units.
 *
 * @param {string} text
 * @param {number} offset   UTF-16 offset to start from
 * @param {number} count    code points to step (sign = direction)
 * @returns {number} the resulting UTF-16 offset, clamped to [0, text.length]
 */
const stepCodePoints = (text, offset, count) => {
  let i = offset;
  if (count >= 0) {
    for (let n = 0; n < count && i < text.length; n++) {
      i += text.codePointAt(i) > 0xFFFF ? 2 : 1;
    }
  } else {
    for (let n = 0; n > count && i > 0; n--) {
      i -= (i > 1 && /[\uDC00-\uDFFF]/.test(text[i - 1])
        && /[\uD800-\uDBFF]/.test(text[i - 2])) ? 2 : 1;
    }
  }
  return Math.min(Math.max(0, i), text.length);
};

module.exports = {
    capitalize
  , dropSpaces
  , normalizeSpec
  , charClass
  , firstNonBlank
  , firstNonBlankLanding
  , lastNonBlank
  , swapCase
  , rot13
  , stepCodePoints
};
