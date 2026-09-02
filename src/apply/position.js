/**
 * @file src/apply/position.js
 * @description Applying a single-coordinate target: the inclusive / exclusive corrections Vim makes to a motion, the cursor move, and the selection an operator draws to it.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const vscode = require("vscode");
const { VSCODE_COMMANDS } = require("../constants/commands.js");
const { REVEAL_TYPE } = require("../ui/highlight.js");
const { lineSpanSelection } = require("./linewise.js");
/**
 * A forward inclusive motion (f / t / e / E / ge / gE / $ / g_) makes an operator include its
 * target char -- the effective landing is one char past it, clamped to the line. "go" never bumps.
 * Shared by onAccept and the live preview so the previewed selection matches what Enter applies.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {object} target   { kind, line, character, inclusive? }
 * @returns {object} the target, with the inclusive bump applied when it is due
 */
const inclusiveTarget = (editor, operator, target) => {
  if (target.kind === "position" && target.inclusive && operator !== "go") {
    const maxChar = editor.document.lineAt(target.line).text.length;
    return { ...target, character: Math.min(target.character + 1, maxChar) };
  }
  return target;
};

/**
 * Vim exclusive-motion exception 1 (motion.txt:92): for an operator, an EXCLUSIVE (not inclusive,
 * not linewise) motion whose end is in column 1 of a LATER line ends at the end of the previous
 * line instead -- so `dw` on a line's last word, or `d}` / `c}`, keeps the boundary line.
 * Applied centrally so every operator path (delete/yank/change/case/indent) gets it.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved
 * @param {object} target
 * @returns {object} the target, endpoint pulled back when the exception applies
 */
const exclusiveColOne = (editor, operator, saved, target) => {
  if (target.kind === "position" && !target.inclusive && !target.linewise && operator !== "go"
        && target.character === 0 && target.line > saved.active.line) {
    const prev = target.line - 1;
    return { ...target, line: prev, character: editor.document.lineAt(prev).text.length };
  }
  return target;
};

/**
 * Apply an operator to a computable position: go / select / selectLine / delete / yank.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved   the selection when the picker opened
 * @param {object} target            { line, character }
 * @returns {Promise<void>}
 */
const applyPosition = async (editor, operator, saved, target) => {
  // the exclusive col-1 pullback (Vim exception 1) is applied centrally in onAccept before this.
  const destination = new vscode.Position(target.line, target.character);
  const anchor      = saved.active;

  if (operator === "go") {
    editor.selection = new vscode.Selection(destination, destination);
  } else if (operator === "select") {
    editor.selection = new vscode.Selection(anchor, destination);
  } else if (operator === "selectLine") {
    editor.selection = lineSpanSelection(editor, anchor.line, destination.line);
  } else if (operator === "delete") {
    const range = new vscode.Range(anchor, destination);
    await editor.edit((builder) => builder.delete(range));

        // after delete, the destination is gone; reveal where the cursor lands
        editor.revealRange(new vscode.Range(range.start, range.start), REVEAL_TYPE);
        return;
  } else if (operator === "yank") {
    const range = new vscode.Range(anchor, destination);
    const text  = editor.document.getText(range);
    if (text) await vscode.env.clipboard.writeText(text); // empty -> keep the clipboard
    // land at the START of the yanked span, like Vim -- a backward motion must not leave the
    // cursor at the original (larger) anchor. Same rule as a range yank.
    editor.selection = new vscode.Selection(range.start, range.start);
  }
    editor.revealRange(new vscode.Range(destination, destination), REVEAL_TYPE);
};

/**
 * End character of an A->B span as a selection or edit needs it: a text object's end IS its last
 * char (inclusive), so bump one past it, clamped to the line; an explicit range end stays as typed
 * (exclusive). One helper because applyRange, selectToTarget and the live preview must all draw
 * the same span (B120).
 *
 * @param {vscode.TextEditor} editor
 * @param {object} target   { end: {line, character}, inclusive? }
 * @returns {number}
 */
const inclusiveRangeEnd = (editor, target) => target.inclusive
  ? Math.min(target.end.character + 1, editor.document.lineAt(target.end.line).text.length)
  : target.end.character;

/**
 * Select from the saved cursor to a motion target, for the operators that act on a range
 * (change / indent / case). The bracket target uses its matching VS Code select command.
 *
 * @param {vscode.TextEditor} editor
 * @param {vscode.Selection} saved
 * @param {object} target
 * @returns {Promise<void>}
 */
const selectToTarget = async (editor, saved, target) => {
  editor.selection = saved;
  if (target.kind === "position") {
    // a LINEWISE motion (gugg / guj / >G ...) covers the WHOLE lines it spans (Vim linewise
    // operator), not just up to the landing column.
    if (target.linewise) {
      const top    = Math.min(saved.active.line, target.line);
      const bottom = Math.max(saved.active.line, target.line);
      editor.selection = new vscode.Selection(top, 0, bottom
        , editor.document.lineAt(bottom).text.length);
      return;
    }
    editor.selection = new vscode.Selection(saved.active
      , new vscode.Position(target.line, target.character));
  } else if (target.kind === "range") {
    // Text objects and explicit `A;B` spans land here (indent/format/case/fold too). End-char
    // rule shared with applyRange via inclusiveRangeEnd; a linewise object covers whole lines.
    const { start, end } = target;
    editor.selection = target.linewise
      ? new vscode.Selection(start.line, 0, end.line
        , editor.document.lineAt(end.line).text.length)
      : new vscode.Selection(start.line, start.character, end.line
        , inclusiveRangeEnd(editor, target));
  } else if (target.kind === "bracket") {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.SELECT_TO_BRACKET);
  }
};

module.exports = {
    inclusiveTarget
  , exclusiveColOne
  , inclusiveRangeEnd
  , applyPosition
  , selectToTarget
};
