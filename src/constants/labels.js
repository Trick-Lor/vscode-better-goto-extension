/**
 * @file src/constants/labels.js
 * @description Fixed user-facing strings: the whole-line operator labels, the text-object names,
 *   and the Invalid-input label / detail / title trio.
 * @scope src
 * @updated-at 2026-09-02
 */
"use strict";

const { table } = require("../utils/table.js");

// Whole-line ("dd" / "yy" / ">>") label -- a self-contained line op has no "to <target>" part.
const WHOLE_LINE_LABEL = table({
    delete    : "Delete the current line."
  , yank      : "Copy the current line."
  , change    : "Change the current line."
  , indent    : "Indent the current line."
  , outdent   : "Outdent the current line."
  , format    : "Format the current line."
  , lowercase : "Lowercase the current line."
  , uppercase : "Uppercase the current line."
  , togglecase: "Toggle case of the current line."
  , rot13     : "Rot13 encode the current line."
});

// human name per object key, for the label ("Select an inner word." / "No block around the cursor")
const TEXTOBJ_NAMES = table({
    w   : "word", W   : "WORD", s   : "sentence", p   : "paragraph", t   : "tag block"
  , "(" : "block", ")" : "block", b   : "block"
  , "{" : "Block", "}" : "Block", B   : "Block"
  , "[" : "[] block", "]" : "[] block"
  , "<" : "<> block", ">" : "<> block"
  , "\"": "quoted string", "'" : "quoted string", "`" : "quoted string"
});

// Shown when the box has non-empty but unparseable input (vs the empty-state prompt). The
// label stays short so it never truncates; the detail carries the syntax examples on a second line.
const INVALID_LABEL  = "Invalid input";
// The hint names "\" as well as ":" because the two are interchangeable (B111) and nothing else in
// the UI ever says so -- a user whose habit was the old "," gets no other clue that "42\8" works.
const INVALID_DETAIL = "try: 42 / 42:8 (or 42\\8) / ±5 / \\5 / 50% / Vim command (gg, w, f<char>, ...)";
// no-vim mode drops the Vim suggestion (those commands are off) and points at the setting instead.
const INVALID_DETAIL_NO_VIM =
  "try: 42 / 42:8 (or 42\\8) / ±5 / \\5 / 50% -- Vim off; enable betterGoto.vim";
// Shown as the box title only in no-vim mode, so the disabled half is visible before a rejection.
const NO_VIM_TITLE = "Better Go to Line/Column -- Vim commands off";

module.exports = {
    WHOLE_LINE_LABEL
  , TEXTOBJ_NAMES
  , INVALID_LABEL
  , INVALID_DETAIL
  , INVALID_DETAIL_NO_VIM
  , NO_VIM_TITLE
};
