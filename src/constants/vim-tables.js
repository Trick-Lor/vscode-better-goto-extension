/**
 * @file src/constants/vim-tables.js
 * @description The Vim operator registry: which keys are operators, the verb / action words each
 *   operator shows, which operators accept a RANGE target, and the case / indent operator sets.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

const { table } = require("../utils/table.js");

/**
 * `v` / `V` render Vim's Visual-mode SEQUENCE `v{motion}` / `V{motion}` (visual.txt:61-72): the
 * observable result is a charwise / linewise selection from the cursor to the motion target, which
 * a one-shot box reproduces exactly. It cannot STAY in Visual mode afterwards -- the same kind of
 * documented degrade as `c`, which cannot enter Insert mode but still performs the change.
 */
const OPERATORS = table({
    v  : "select"
  , V  : "selectLine"
  , d  : "delete"
  , y  : "yank"
  , c  : "change"
  , ">": "indent"
  , "<": "outdent"
  , "=": "format"
});

// "gX" case operators and doubled "XX" whole-line operators -- detected before the single-char ops.
const CASE_OPERATORS = table(
  { u: "lowercase", U: "uppercase", "~": "togglecase", "?": "rot13" });
const DOUBLE_OPERATORS = table({
    d  : "delete"
  , y  : "yank"
  , c  : "change"
  , ">": "indent"
  , "<": "outdent"
  , "=": "format"
});

const VERB = table({
    go        : "Go to"
  , select    : "Select to"
  , selectLine: "Select (line) to"
  , delete    : "Delete to"
  , yank      : "Copy to"
  , change    : "Change to"
  , indent    : "Indent to"
  , outdent   : "Outdent to"
  , format    : "Format to"
  , lowercase : "Lowercase to"
  , uppercase : "Uppercase to"
  , togglecase: "Toggle case to"
  , rot13     : "Rot13 to"
  , fold      : "Fold to"
});

// lowercase action word for the operator-pending guidance ("Type a target to delete.")
const ACTION = table({
    select    : "select"
  , selectLine: "select whole lines"
  , delete    : "delete"
  , yank      : "copy"
  , change    : "change"
  , indent    : "indent"
  , outdent   : "outdent"
  , format    : "format"
  , lowercase : "lowercase"
  , uppercase : "uppercase"
  , togglecase: "toggle case"
  , rot13     : "rot13 encode"
  // no whole-line doubled form: fold.txt documents no "zfzf" synonym, unlike gqgq/gwgw.
  , fold: "fold"
});

/**
 * Label verb for a two-coordinate range (operator applied to an explicit A->B span). "go" and `v`
 * with a range both mean "select it"; `V` selects the whole lines it spans.
 * Which operators can consume a RANGE target (a text object, or an explicit `A;B` two-coordinate
 * range). The indent / format trio was missing, which is why `=aw` / `>ap` / `gqiw` were Invalid
 * while `daw` / `yaw` / `vaw` all worked -- the same object, accepted by five operators and refused
 * by three, with no rule behind the split. `gq` / `gw` inherit this, since they rewrite to `=`.
 */
const RANGE_VERB = table({
    go        : "Select"
  , select    : "Select"
  , selectLine: "Select lines"
  , delete    : "Delete"
  , yank      : "Copy"
  , change    : "Change"
  , indent    : "Indent"
  , outdent   : "Outdent"
  , format    : "Format"
  /**
   * And the case operators, blocked by the same omission: `guaw` / `gUiw` / `g~ap` are everyday
   * Vim and were Invalid, while `guj` and `guu` worked. applyCase reads editor.selection after
   * selectToTarget, so it needs nothing beyond being allowed through.
   */
  , lowercase : "Lowercase"
  , uppercase : "Uppercase"
  , togglecase: "Toggle case of"
  , rot13     : "Rot13"
  // zf{motion} (B114): "Fold" reads as a verb same as the others -- "Fold line 5 to line 9."
  , fold: "Fold"
});

// Operators that act on the motion RANGE (not the go/d/y move/delete/yank paths).
const CASE_OPS = new Set(["lowercase", "uppercase", "togglecase", "rot13"]);
/**
 * "fold" joins this set at B114: zf{motion} is a real Vim OPERATOR (fold.txt:322-323, "Operator to
 * create a fold"), not just the bare zf/zF selection-fold built at B112/B113. It reuses this same
 * select-then-run-one-command apply path -- the fold command just happens to be
 * createFoldingRangeFromSelection instead of an indent/format command.
 */
const INDENT_OPS = new Set(["indent", "outdent", "format", "fold"]);

module.exports = {
    OPERATORS
  , CASE_OPERATORS
  , DOUBLE_OPERATORS
  , VERB
  , ACTION
  , RANGE_VERB
  , CASE_OPS
  , INDENT_OPS
};
