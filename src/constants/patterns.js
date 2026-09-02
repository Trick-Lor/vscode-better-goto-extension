/**
 * @file src/constants/patterns.js
 * @description The shared parse regexes: delimiters, line / column / percent chains, word and find
 *   motions, paste, the pending-input probes, and the text-object key tables.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

/**
 * ":" only -- "#" was handed back to Vim at B108 (`#` = search backward for the word under the
 * cursor, pattern.txt), and "," was handed back to Vim at B110 (`,` = repeat the latest f/t/F/T
 * in the opposite direction, motion.txt:305-306). Neither removal lost a capability: "#"/","
 * were synonyms of ":" for the SAME column delimiter, except the "," LEADING form (`,5` = current-
 * line column, no line number before it) -- that one has no ":" equivalent (":5" already means
 * "line 5"), so it moved to "\" instead (never a Vim command head, see REGEX_BACKSLASH below).
 */
const DELIMITER          = /[:\\]/;
const REGEX_REL_CHAIN    = /^[+-]\d+(?:[+-]\d+)*$/;  // +5, +5+5, -3
// N% (percent of file) / +N% / -N% (relative by N% of file), each with an optional chain + column
const REGEX_PERCENT      = /^([+-])?(\d+)%((?:[+-]\d+%?)+)?(?:[:\\]([^:\\]*))?$/;
// line base (absolute or signed) + percent offset, optional further line chain + column: 20+10%,
// +5+10%, 20+10%+5, 5+10%:3
const REGEX_LINE_PCT     = /^([+-]?\d+(?:[+-]\d+)*)([+-]\d+)%((?:[+-]\d+%?)*)(?:[:\\]([^:\\]*))?$/;
// column at N% of the line (+ chain): 50%, 50%+2
const REGEX_COL_PCT      = /^(\d+)%((?:[+-]\d+%?)*)$/;
// column base + percent offset: 3+50%
const REGEX_COL_BASE_PCT = /^([+-]?\d+(?:[+-]\d+)*)([+-]\d+)%((?:[+-]\d+%?)*)$/;
// signed/relative % of the line (+ chain): +50%, -1%
const REGEX_COL_REL_PCT  = /^([+-]\d+)%((?:[+-]\d+%?)*)$/;
const REGEX_NUMBER       = /^\d+$/;
const REGEX_ABS_CHAIN    = /^(\d+)((?:[+-]\d+)+)$/;  // absolute base + offset: 50+1, 8-2
// a LINE number has VALUE >= 1 -- leading zeros are fine (05 = line 5), but an all-zero value is
// not a line ("0" is the start-of-line motion). Line bases use these; columns / percents do not.
const REGEX_LINE_INT     = /^0*[1-9]\d*$/;             // line value >= 1: 5, 05 (not 0, 00)
const REGEX_LINE_CHAIN   = /^0*[1-9]\d*(?:[+-]\d+)+$/; // line base + offset: 50+1 (not 0+1)
const REGEX_WORD         = /^([1-9]\d*)?([wbe])$/;   // word motion, count >= 1 (no count 0): w, 2w
const REGEX_BIGWORD      = /^([1-9]\d*)?([WBE])$/;   // whitespace-delimited WORD: W, 2B, E
const REGEX_GE           = /^([1-9]\d*)?(ge|gE)$/;   // backward to word/WORD end: ge, gE
const REGEX_FIND         = /^([1-9]\d*)?([fFtT])(.)$/u; // find a char: fx, 2tx; /u = emoji {char} (B124)
/**
 * [count], -- repeat the latest f/F/t/T in the OPPOSITE direction (motion.txt:305-306, B110).
 * Repeat the latest f/F/t/T: `;` keeps its direction, `,` flips it (index.txt:413 / motion.txt:305).
 * Group 2 is which of the two, so one branch serves both -- the only difference is whether the
 * motion is reversed before the re-search.
 *
 * `,` takes a count; `;` deliberately does NOT. `N;` is already better-goto's range half --
 * the first point of `5;5:9` -- and it must keep pending there even in no-vim mode, where every
 * Vim command is rejected. A Vim count on `;` would have to win in one mode and lose in the other,
 * which is not a thing one spelling can do. Bare `;` is free because an empty first point is not a
 * range, so it costs the range grammar nothing. Divergence recorded in docs/vim-coverage.md.
 */
const REGEX_FIND_REPEAT  = /^(?:([1-9]\d*)?(,)|(;))$/;
/**
 * "\" is better-goto's OWN column marker (design.md; no Vim analog). It is never a Vim
 * normal-mode command head (index.txt sweep, tag v9.2.0699: 0 of 408 rows), so it cannot collide
 * the way "," did -- which is why it took over BOTH jobs the old "," had: the LEADING form (`\5` =
 * column on the current line) and the MIDDLE delimiter (`2\2` == `2:2`), interchangeable with ":"
 * exactly as "," used to be. A leading "\" is the only form ":" cannot express, since ":5" already
 * means "line 5"; the middle form is a pure synonym kept so the swap reads 1-for-1.
 */
const REGEX_BACKSLASH     = /^\\/;

/**
 * PUT (paste): `[count]p` / `P`, the `g` cursor-variants `gp` / `gP`, and the indent-adjusting
 * bracket forms `]p` / `[p` / `]P` / `[P` (change.txt:1109-1178). Group 2 is the variant prefix
 * ("" | "g" | "[" | "]"), group 3 the p/P key. The register prefix `["x]` is NOT accepted: the box
 * keeps no named registers, so a put always reads the system clipboard that y / d / yy wrote.
 */
const REGEX_PASTE        = /^([1-9]\d*)?(g|\[|\])?([pP])$/;
// two-coordinate range: 5:5;5:9 -- ";" ONLY (`~` is Vim's toggle-case command, `>` the indent op)
const RANGE_SEP          = /;/;
// trailing-token probes for the pending-input guidance, hoisted out of the hot path
const REGEX_LEADING_COUNT  = /^[1-9]\d*/;  // strip a leading motion count
const REGEX_FIND_KEY       = /^[fFtT]$/;   // a lone find key awaiting its char
const REGEX_DELIM_END      = /[:\\]$/;  // line part + a trailing column delimiter
const REGEX_RANGE_END      = /;$/;         // first range point + a trailing separator
const REGEX_SIGN_END       = /[+-]$/;      // a dangling sign awaiting its number

/**
 * Vim TEXT OBJECTS (motion.txt:545-710). "i" selects the INNER object, "a" the object plus what
 * surrounds it (the brackets / quotes / tag, or the trailing whitespace for a word). The bracket
 * keys carry Vim's synonyms: `b` == `(`/`)`, `B` == `{`/`}`, and each pair's close key is the same
 * object as its open key. Every object resolves to an INCLUSIVE { start, end } range.
 */
const TEXTOBJ_PAIRS = Object.freeze({
    "(": "()", ")": "()", b  : "()"
  , "{": "{}", "}": "{}", B  : "{}"
  , "[": "[]", "]": "[]"
  , "<": "<>", ">": "<>"
});
const TEXTOBJ_QUOTES = "\"'`";
const REGEX_TEXTOBJ  = /^([1-9]\d*)?([ia])(.)$/;

module.exports = {
    DELIMITER
  , REGEX_REL_CHAIN
  , REGEX_PERCENT
  , REGEX_LINE_PCT
  , REGEX_COL_PCT
  , REGEX_COL_BASE_PCT
  , REGEX_COL_REL_PCT
  , REGEX_NUMBER
  , REGEX_ABS_CHAIN
  , REGEX_LINE_INT
  , REGEX_LINE_CHAIN
  , REGEX_WORD
  , REGEX_BIGWORD
  , REGEX_GE
  , REGEX_FIND
  , REGEX_FIND_REPEAT
  , REGEX_BACKSLASH
  , REGEX_PASTE
  , RANGE_SEP
  , REGEX_LEADING_COUNT
  , REGEX_FIND_KEY
  , REGEX_DELIM_END
  , REGEX_RANGE_END
  , REGEX_SIGN_END
  , TEXTOBJ_PAIRS
  , TEXTOBJ_QUOTES
  , REGEX_TEXTOBJ
};
