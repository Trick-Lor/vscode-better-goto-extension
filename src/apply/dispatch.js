/**
 * @file src/apply/dispatch.js
 * @description The router: sends a parsed command to the apply function that matches its target kind. A new editor effect needs one arm here.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { CASE_OPS, INDENT_OPS } = require("../constants/vim-tables.js");
const { applyPosition } = require("./position.js");
const { applyLinewise, applyWholeLine } = require("./linewise.js");
const { applyBracket, applyIndent, applyCase, applyChange } = require("./edit.js");
const { applyRange } = require("./range.js");
/**
 * ROUTE a resolved command to the apply function that performs it. Extracted from onAccept at B114
 * so it can be tested: the routing itself carried a defect no parse assertion could see. From B113
 * until B114 the `target.kind === "range"` arm sat ABOVE the operator-family arms, and applyRange
 * knows only selectLine / delete / change / yank -- so `=aw`, `>ap`, `guaw`, `gUiw`, `gqiw`,
 * `zfaw`, `zfip` fell into its final `else`, which sets the selection and reveals, and executed no
 * command at all. Label right, target right, every assertion green, feature dead. The order below
 * is therefore load-bearing, and test/verify-parse.js drives THIS function (not the helpers it
 * calls) so that reverting the order turns the suite red.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved  the selection to anchor every action at
 * @param {object} target
 * @returns {Promise<void>}
 */
const applyCommand = async (editor, operator, saved, target) => {
  if (target.kind === "wholeLine") {
    await applyWholeLine(editor, operator);
    return;
  }
  // BEFORE the range arm -- both of these route on the OPERATOR, and both go through
  // selectToTarget, which handles position and range kinds alike.
  if (CASE_OPS.has(operator)) {
    await applyCase(editor, operator, saved, target);
    return;
  }
  if (INDENT_OPS.has(operator)) {
    await applyIndent(editor, operator, saved, target);
    return;
  }
  if (target.kind === "range") {
    // a range routes by its verb (applyRange handles go/change/delete/yank alike) -- this must
    // precede the generic change branch, else change+range would reach applyChange, which has
    // no range path, and silently no-op.
    await applyRange(editor, operator, target);
    return;
  }
  if (target.kind === "position" && target.linewise
        && (operator === "delete" || operator === "yank" || operator === "change")) {
    // a linewise motion (dG / dj / dgg / d+ ...) deletes / yanks / changes WHOLE lines
    await applyLinewise(editor, operator, saved, target);
    return;
  }
  if (operator === "change") {
    await applyChange(editor, saved, target);
    return;
  }
  if (target.kind === "position") {
    await applyPosition(editor, operator, saved, target);
    return;
  }
  if (target.kind === "bracket") await applyBracket(editor, operator);
};

module.exports = {
    applyCommand
};
