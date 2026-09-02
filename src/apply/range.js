/**
 * @file src/apply/range.js
 * @description Applying a two-coordinate span: the ordinary A-to-B range, and the ex [range] commands that move, copy, join, sort or substitute over it.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const vscode = require("vscode");
const { clamp } = require("../utils/math.js");
const { VSCODE_COMMANDS, INDENT_COMMANDS } = require("../constants/commands.js");
const { REVEAL_TYPE } = require("../ui/highlight.js");
const { lineSpanSelection, wholeLinesRange } = require("./linewise.js");
const { inclusiveRangeEnd } = require("./position.js");
/**
 * Apply an operator to an explicit A->B range (no cursor anchor): select / delete / copy / change.
 * The end is EXCLUSIVE (5:5 to 5:9 = 4 chars); endpoints are ordered for the edit ops so a backward
 * range still works.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {object} target   { start: {line, character}, end: {line, character} }
 * @returns {Promise<void>}
 */
const applyRange = async (editor, operator, target) => {
  const a = new vscode.Position(target.start.line, target.start.character);
  // a text object's end is the LAST char of the object; the exclusive-end bump is shared with
  // selectToTarget and the live preview (inclusiveRangeEnd, B120).
  const b = new vscode.Position(target.end.line, inclusiveRangeEnd(editor, target));
  // a LINEWISE range (ip / ap) covers whole lines including the trailing newline, so `dip` on a
  // blank line still deletes that line -- a char range there is zero-width and deletes nothing.
  const range = target.linewise
    ? wholeLinesRange(editor.document, Math.min(a.line, b.line), Math.max(a.line, b.line))
    : new vscode.Range(a, b); // ordered start <= end, for edits

  if (operator === "selectLine") {
    editor.selection = lineSpanSelection(editor, a.line, b.line);
  } else if (operator === "delete" || operator === "change") {
    await editor.edit((builder) => builder.delete(range));
    editor.selection = new vscode.Selection(range.start, range.start);
  } else if (operator === "yank") {
    const text = editor.document.getText(range);
    if (text) await vscode.env.clipboard.writeText(text);
    // land at the top of the yanked span (range.start), matching delete/change -- a backward
    // range must not leave the cursor at the lower typed endpoint.
    editor.selection = new vscode.Selection(range.start, range.start);
  } else if (target.linewise) {
    // go / select on a linewise object selects the whole lines, not a caret-to-caret span
    editor.selection = lineSpanSelection(editor, a.line, b.line);
  } else {
    // go / select: char-wise selection, typed direction kept
    editor.selection = new vscode.Selection(a, b);
  }
    editor.revealRange(new vscode.Range(range.start, range.start), REVEAL_TYPE);
};

/**
 * Run an ex RANGE command on its whole-line span (Vim ex is linewise): delete / yank / join /
 * indent / outdent / sort act on [top..bottom]; move / copy relocate it after `dest` (-1 = before
 * the first line); substitute rewrites each line with the JS-regex pattern.
 *
 * @param {vscode.TextEditor} editor
 * @param {object} target  { verb, top, bottom, dest?, pattern?, replacement?, flags? }
 * @returns {Promise<void>}
 */
const applyExRange = async (editor, target) => {
  const doc  = editor.document;
  const { verb, top, bottom } = target;
  const lineText = (l) => doc.lineAt(l).text;
  const spanLines = () => {
    const out = [];
    for (let l = top; l <= bottom; l++) out.push(lineText(l));
    return out;
  };
  const landAt = (line) => {
    const at = new vscode.Position(clamp(0, doc.lineCount - 1, line), 0);
    editor.selection = new vscode.Selection(at, at);
        editor.revealRange(new vscode.Range(at, at), REVEAL_TYPE);
  };

  if (verb === "yank") {
    const text = doc.getText(wholeLinesRange(doc, top, bottom));
    if (text) await vscode.env.clipboard.writeText(text);
        landAt(top);
        return;
  }
  if (verb === "delete") {
    await editor.edit((b) => b.delete(wholeLinesRange(doc, top, bottom)));
        landAt(top);
        return;
  }
  if (verb === "join") {
    // :[range]j joins the span; a single-line range joins it with the line below (Vim).
    const last = bottom > top ? bottom : Math.min(doc.lineCount - 1, top + 1);
    if (last <= top) return;
    editor.selection = new vscode.Selection(top, 0, last, lineText(last).length);
    await vscode.commands.executeCommand(VSCODE_COMMANDS.JOIN_LINES);
    return;
  }
  if (verb === "indent" || verb === "outdent") {
    editor.selection = new vscode.Selection(top, 0, bottom, lineText(bottom).length);
    // `:>>` shifts twice etc. (B126); each pass is its own undo step, a recorded divergence
    for (let n = 0; n < (target.repeat || 1); n++) {
      await vscode.commands.executeCommand(INDENT_COMMANDS[verb]);
    }
    return;
  }
  if (verb === "sort") {
    const sorted = spanLines().slice().sort((a, b) => a.localeCompare(b));
    await editor.edit((b) => b.replace(
            new vscode.Range(top, 0, bottom, lineText(bottom).length), sorted.join("\n")));
        landAt(top);
        return;
  }
  if (verb === "substitute") {
    // Vim replaces the FIRST match per line; the `g` flag replaces every match. The pattern is
    // a JS regex (a documented divergence from Vim's own regex dialect).
    let regex;
    const jsFlags = (target.flags.includes("g") ? "g" : "")
            + (target.flags.includes("i") ? "i" : "");
    try {
      regex = new RegExp(target.pattern, jsFlags);
    } catch {
      return; // an unparseable pattern does nothing, rather than throwing
    }
    await editor.edit((b) => {
      for (let l = top; l <= bottom; l++) {
        const before = lineText(l);
        const after  = before.replace(regex, target.replacement);
        if (after !== before) b.replace(new vscode.Range(l, 0, l, before.length), after);
      }
    });
    return;
  }
  // move / copy -- the span's text, inserted AFTER `dest` (-1 = before the first line).
  const text = spanLines().join("\n");
  const dest = target.dest;
  if (verb === "copy") {
    await editor.edit((b) => {
      if (dest < 0) b.insert(new vscode.Position(0, 0), text + "\n");
      else b.insert(new vscode.Position(dest, lineText(dest).length), "\n" + text);
    });
        landAt(dest < 0 ? bottom - top : dest + (bottom - top) + 1);
        return;
  }
  if (verb === "move") {
    // a destination INSIDE the moved span is a no-op (Vim E134); otherwise cut then insert.
    if (dest >= top - 1 && dest <= bottom) return;
    await editor.edit((b) => {
            b.delete(wholeLinesRange(doc, top, bottom));
            if (dest < 0) b.insert(new vscode.Position(0, 0), text + "\n");
            else b.insert(new vscode.Position(dest, lineText(dest).length), "\n" + text);
    });
        landAt(dest < 0 ? 0 : dest);
  }
};

module.exports = {
    applyRange
  , applyExRange
};
