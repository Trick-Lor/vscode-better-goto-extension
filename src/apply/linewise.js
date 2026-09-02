/**
 * @file src/apply/linewise.js
 * @description Applying a whole-line target: the line span an operator covers, and the delete / yank / change of complete lines including their line breaks.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const vscode = require("vscode");
const { swapCase, rot13 } = require("../utils/text.js");
const { VSCODE_COMMANDS, INDENT_COMMANDS } = require("../constants/commands.js");
const { CASE_OPS, INDENT_OPS } = require("../constants/vim-tables.js");
const { REVEAL_TYPE } = require("../ui/highlight.js");
/**
 * Whole-line selection across lineA..lineB (either order): full first line through full last line.
 * The linewise half of `V` (and a `V` range / bracket).
 *
 * @param {vscode.TextEditor} editor
 * @param {number} lineA  0-based
 * @param {number} lineB  0-based
 * @returns {vscode.Selection}
 */
const lineSpanSelection = (editor, lineA, lineB) => {
  const top    = Math.min(lineA, lineB);
  const bottom = Math.max(lineA, lineB);
  return new vscode.Selection(
    new vscode.Position(top, 0)
    , new vscode.Position(bottom, editor.document.lineAt(bottom).text.length)
  );
};

/**
 * Range that covers whole lines top..bottom, including the trailing newline so no blank line is
 * left behind (at EOF it takes the preceding newline instead).
 *
 * @param {vscode.TextDocument} document
 * @param {number} top      0-based first line
 * @param {number} bottom   0-based last line
 * @returns {vscode.Range}
 */
const wholeLinesRange = (document, top, bottom) => {
  if (bottom + 1 < document.lineCount) return new vscode.Range(top, 0, bottom + 1, 0);
  if (top > 0) {
    return new vscode.Range(top - 1, document.lineAt(top - 1).text.length
      , bottom, document.lineAt(bottom).text.length);
  }
  return new vscode.Range(top, 0, bottom, document.lineAt(bottom).text.length);
};

/**
 * Apply a LINEWISE motion under an operator: delete / yank / change act on WHOLE lines from the
 * cursor line to the target line (Vim: dG / dj / dgg etc. are linewise). Only d/y/c route here.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved
 * @param {object} target   { line, character }
 * @returns {Promise<void>}
 */
const applyLinewise = async (editor, operator, saved, target) => {
  const top    = Math.min(saved.active.line, target.line);
  const bottom = Math.max(saved.active.line, target.line);
  const range  = wholeLinesRange(editor.document, top, bottom);
  if (operator === "yank") {
    const text = editor.document.getText(range);
    if (text) await vscode.env.clipboard.writeText(text);
    const start = new vscode.Position(top, 0);
    editor.selection = new vscode.Selection(start, start);
  } else { // delete / change -- the box's change deletes the span and leaves the cursor there
    await editor.edit((builder) => builder.delete(range));
  }
    editor.revealRange(new vscode.Range(top, 0, top, 0), REVEAL_TYPE);
};

/**
 * Apply a doubled-operator whole-line command ("dd" / "yy" / "cc" / ">>" / "<<" / "==").
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @returns {Promise<void>}
 */
const applyWholeLine = async (editor, operator) => {
  const document = editor.document;
  const line     = editor.selection.active.line;
  const text     = document.lineAt(line);

  if (operator === "yank") {
    await vscode.env.clipboard.writeText(text.text + "\n");
    return;
  }
  if (INDENT_OPS.has(operator)) {
    editor.selection = new vscode.Selection(line, 0, line, text.text.length);
    await vscode.commands.executeCommand(INDENT_COMMANDS[operator]);
    return;
  }
  if (CASE_OPS.has(operator)) {
    const range = new vscode.Range(line, 0, line, text.text.length);
    if (operator === "togglecase" || operator === "rot13") {
      const rewrite = operator === "rot13" ? rot13 : swapCase;
      await editor.edit((builder) => builder.replace(range, rewrite(text.text)));
      return;
    }
    editor.selection = new vscode.Selection(range.start, range.end);
    await vscode.commands.executeCommand(operator === "lowercase"
      ? VSCODE_COMMANDS.TO_LOWERCASE
      : VSCODE_COMMANDS.TO_UPPERCASE);
    return;
  }
  if (operator === "change") {
    await editor.edit((builder) => builder.delete(text.range)); // keep the (now blank) line
    editor.selection = new vscode.Selection(line, 0, line, 0);
    return;
  }
  // delete: drop the whole line including its line break
  const isLast = line === document.lineCount - 1;
  const range  = isLast && line > 0
    ? new vscode.Range(line - 1, document.lineAt(line - 1).text.length, line, text.text.length)
    : new vscode.Range(line, 0, Math.min(line + 1, document.lineCount - 1)
      , isLast ? text.text.length : 0);
  await editor.edit((builder) => builder.delete(range));
};

module.exports = {
    lineSpanSelection
  , wholeLinesRange
  , applyLinewise
  , applyWholeLine
};
