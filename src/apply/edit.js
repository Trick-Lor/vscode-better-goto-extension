/**
 * @file src/apply/edit.js
 * @description The editor effects that are not a plain move: bracket jumps, indent, case, change, put, and the self-contained one-shot actions.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const vscode = require("vscode");
const { firstNonBlankLanding, swapCase, rot13, stepCodePoints } = require("../utils/text.js");
const { VSCODE_COMMANDS, INDENT_COMMANDS } = require("../constants/commands.js");
const { lineSpanSelection } = require("./linewise.js");
const { selectToTarget } = require("./position.js");
const { applyExRange } = require("./range.js");
/**
 * Run the matching-bracket command for the operator (delete / yank select first, then act).
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @returns {Promise<void>}
 */
const applyBracket = async (editor, operator) => {
  if (operator === "go") {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.JUMP_TO_BRACKET);
    return;
  }
  await vscode.commands.executeCommand(VSCODE_COMMANDS.SELECT_TO_BRACKET);
  if (operator === "delete") {
    await editor.edit((builder) => builder.delete(editor.selection));
  } else if (operator === "yank") {
    const text  = editor.document.getText(editor.selection);
    // Vim leaves the cursor at the START of a yanked span; for a backward `%` (cursor on a
    // closing bracket) that is the matching open, i.e. selection.start, not the anchor.
    const start = editor.selection.start;
    if (text) await vscode.env.clipboard.writeText(text); // empty -> keep the clipboard
    editor.selection = new vscode.Selection(start, start);
  } else if (operator === "selectLine") {
    // `V%` selects WHOLE lines from the cursor to the bracket -- expand the char-wise bracket
    // selection to its line span, like every other selectLine path. (`v%` needs no expansion:
    // selectToBracket already leaves exactly the char-wise selection.)
    const selection = editor.selection;
    editor.selection = lineSpanSelection(editor, selection.anchor.line, selection.active.line);
  }
};

/**
 * Indent / outdent / format the motion range.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved
 * @param {object} target
 * @returns {Promise<void>}
 */
const applyIndent = async (editor, operator, saved, target) => {
  await selectToTarget(editor, saved, target);
  await vscode.commands.executeCommand(INDENT_COMMANDS[operator]);
};

/**
 * Lower- / upper- / toggle-case the motion range. Toggle has no built-in command, so it is a
 * manual swapcase rewrite.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} operator
 * @param {vscode.Selection} saved
 * @param {object} target
 * @returns {Promise<void>}
 */
const applyCase = async (editor, operator, saved, target) => {
  await selectToTarget(editor, saved, target);
  if (operator === "lowercase") {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.TO_LOWERCASE);
    return;
  }
  if (operator === "uppercase") {
    await vscode.commands.executeCommand(VSCODE_COMMANDS.TO_UPPERCASE);
    return;
  }
  // togglecase / rot13 have no built-in command -- manual rewrite of the selected text.
  const selection = editor.selection;
  const rewrite   = operator === "rot13" ? rot13 : swapCase;
  await editor.edit((builder) => builder.replace(selection
        , rewrite(editor.document.getText(selection))));
};

/**
 * Change = delete the motion range, then leave the cursor at the start. A one-shot box cannot enter
 * Vim insert mode, so it stops with the editor ready to type.
 *
 * @param {vscode.TextEditor} editor
 * @param {vscode.Selection} saved
 * @param {object} target
 * @returns {Promise<void>}
 */
const applyChange = async (editor, saved, target) => {
  await selectToTarget(editor, saved, target);
  const start = editor.selection.start;
  await editor.edit((builder) => builder.delete(editor.selection));
  editor.selection = new vscode.Selection(start, start);
};

/**
 * PUT the clipboard (change.txt:1109-1178). The box keeps no named registers, so the clipboard IS
 * the unnamed register -- y / d / yy / dd already write it. LINEWISE is carried the way those
 * writers encode it: a trailing newline (applyWholeLine writes `text + "\n"` for yy / dd), which
 * matches how VS Code's own copy marks a whole-line cut. Linewise puts go on their own line(s)
 * below (p) or above (P); charwise puts land after (p) or at (P) the cursor character.
 *
 * @param {vscode.TextEditor} editor
 * @param {object} target   { count, after, indent, cursorAfter }
 * @returns {Promise<void>}
 */
const applyPaste = async (editor, target) => {
  const clip = await vscode.env.clipboard.readText();
  if (!clip) return;                                  // nothing yanked yet -- a put is a no-op
  const doc      = editor.document;
  const pos      = editor.selection.active;
  const linewise = clip.endsWith("\n");
  const count    = target.count || 1;

  if (linewise) {
    const body = clip.slice(0, -1);                 // drop the marker newline before repeating
    let lines  = [];
    for (let n = 0; n < count; n++) lines = lines.concat(body.split("\n"));
    if (target.indent) {
      // ]p / [p / ]P / [P re-indent the pasted block to the current line (change.txt:1168).
      const own  = (doc.lineAt(pos.line).text.match(/^\s*/) || [""])[0];
      const base = lines.reduce((least, line) => line.trim() === "" ? least
        : Math.min(least, line.length - line.trimStart().length), Infinity);
      const trim = base === Infinity ? 0 : base;
      lines = lines.map((line) => line.trim() === "" ? line : own + line.slice(trim));
    }
    const at   = target.after ? pos.line + 1 : pos.line;
    const text = lines.join("\n") + "\n";
    // A TextDocument is LIVE (vscode.d.ts:150-157 marks lineAt's RESULT as not-live precisely
    // because the document is), so lineCount read after the edit is the POST-edit count. The
    // landing line must be computed from the count taken BEFORE it.
    const before = doc.lineCount;
    const atEnd  = at >= before;   // inserting past the end has no line to anchor at column 0
    await editor.edit((b) => atEnd
      ? b.insert(new vscode.Position(before - 1, doc.lineAt(before - 1).text.length)
                , "\n" + lines.join("\n"))
      : b.insert(new vscode.Position(at, 0), text));
    // Vim lands on the first non-blank of the FIRST pasted line; gp lands just past the block.
    const first = atEnd ? before : at;
    const land  = target.cursorAfter ? first + lines.length : first;
    const dest  = Math.min(land, editor.document.lineCount - 1);
    const col   = target.cursorAfter ? 0
      : firstNonBlankLanding(editor.document.lineAt(dest).text);
    editor.selection = new vscode.Selection(dest, col, dest, col);
    return;
  }

  const text  = clip.repeat(count);
  const line  = doc.lineAt(pos.line).text;
  const start = target.after ? Math.min(pos.character + 1, line.length) : pos.character;
  await editor.edit((b) => b.insert(new vscode.Position(pos.line, start), text));
  // Vim leaves the cursor ON the last pasted char; gp / gP leave it one past the new text. A
  // charwise register can still CONTAIN newlines (a `y` motion across a line break), so the end
  // of the pasted text is not always on pos.line -- walking it as a column would land the cursor
  // on the wrong line entirely.
  const parts   = text.split("\n");
  const endLine = pos.line + parts.length - 1;
  const endCol  = parts.length === 1 ? start + text.length : parts[parts.length - 1].length;
  const rest    = editor.document.lineAt(endLine).text.length;
  const col     = target.cursorAfter
    ? Math.min(endCol, rest)
    : Math.min(Math.max(0, endCol - 1), rest);
  editor.selection = new vscode.Selection(endLine, col, endLine, col);
};

/**
 * Run a self-contained one-shot command (x / X / J / gJ / ~ / r{char} / z scroll) at the cursor.
 * Each acts on [count] characters (or lines, for J / gJ / the scrolls) at the cursor position.
 * Character ops step CODE POINTS (stepCodePoints) so a surrogate pair is one char, as in Vim.
 *
 * @param {vscode.TextEditor} editor
 * @param {object} target   { kind: "action", action, count, char? } | { action: "scroll", ... }
 * @returns {Promise<void>}
 */
const applyAction = async (editor, target) => {
  const count = target.count || 1;
  const doc   = editor.document;
  if (target.action === "ex") {
    // an ex command runs its workbench command(s) in order (:wq = save, then close). A command
    // may carry ARGUMENTS as [id, arg] instead of a bare id -- the display-line motions (B112)
    // need them, since they are all one command (cursorMove) distinguished only by its args.
    for (const command of target.commands) {
      if (Array.isArray(command)) await vscode.commands.executeCommand(command[0], command[1]);
      else await vscode.commands.executeCommand(command);
    }
    return;
  }
  if (target.action === "exRange") {
    await applyExRange(editor, target);
    return;
  }
  if (target.action === "scroll") {
    // [count]zt / zz / zb put line [count] (default: the cursor line) at the top / center /
    // bottom; z. / z- also move the cursor to that line's first non-blank (scroll.txt:113-144).
    const line = target.line
      ? Math.min(doc.lineCount - 1, target.line - 1)
      : editor.selection.active.line;
    if (target.move || target.line) {
      const character = target.move
        ? firstNonBlankLanding(doc.lineAt(line).text)
      // zt/zz/zb with a count move to that line, keeping the column (clamped to its end).
        : Math.min(editor.selection.active.character, doc.lineAt(line).text.length);
      editor.selection = new vscode.Selection(line, character, line, character);
    }
    if (target.spot === "center") {
            editor.revealRange(new vscode.Range(line, 0, line, 0)
                , vscode.TextEditorRevealType.InCenter);
    } else if (target.spot === "top") {
            editor.revealRange(new vscode.Range(line, 0, line, 0)
                , vscode.TextEditorRevealType.AtTop);
    } else {
      // no AtBottom reveal type exists (vscode.d.ts TextEditorRevealType) -- put the line
      // that sits one viewport-height above at the top instead. Folded-away lines shrink
      // the visible span, so the height sums the visible ranges.
      const visible = editor.visibleRanges;
      const height  = visible.reduce(
                (sum, range) => sum + (range.end.line - range.start.line + 1), 0);
      const top = Math.max(0, line - Math.max(1, height - 1));
            editor.revealRange(new vscode.Range(top, 0, top, 0)
                , vscode.TextEditorRevealType.AtTop);
    }
    return;
  }
  if (target.action === "paste") {
    await applyPaste(editor, target);
    return;
  }
  if (target.action === "joinLines" || target.action === "joinNoSpace") {
    const startLine = editor.selection.active.line;         // J joins >= 2 lines; {n}J joins n
    const endLine   = Math.min(doc.lineCount - 1, startLine + Math.max(2, count) - 1);
    if (endLine <= startLine) return;
    const span = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    if (target.action === "joinLines") {
      editor.selection = new vscode.Selection(span.start, span.end); // VS Code join
      await vscode.commands.executeCommand(VSCODE_COMMANDS.JOIN_LINES);
    } else {                                                 // gJ: drop the line breaks only
      let joined = "";
      for (let l = startLine; l <= endLine; l++) joined += doc.lineAt(l).text;
      await editor.edit((b) => b.replace(span, joined));
    }
    return;
  }
  const pos  = editor.selection.active;
  const line = pos.line;
  const text = doc.lineAt(line).text;
  if (target.action === "deleteCharUnder") {
    const end = stepCodePoints(text, pos.character, count);
    if (end > pos.character) await editor.edit((b) => b.delete(new vscode.Range(line
      , pos.character, line, end)));
  } else if (target.action === "deleteCharBefore") {
    const start = stepCodePoints(text, pos.character, -count);
    if (pos.character > start) await editor.edit((b) => b.delete(new vscode.Range(line
      , start, line, pos.character)));
  } else if (target.action === "replaceChar") {
    // Vim replaces EXACTLY [count] chars or nothing (change.txt:286); a count past the line end
    // is a no-op, never a partial replace -- so first prove [count] chars really exist.
    const end = stepCodePoints(text, pos.character, count);
    const replaced = Array.from(text.slice(pos.character, end)).length;
    if (replaced === count) {
      await editor.edit((b) => b.replace(new vscode.Range(line, pos.character, line
        , end), target.char.repeat(count)));
    }
  } else if (target.action === "toggleCaseChar") {
    if (pos.character < text.length) {
      const after = stepCodePoints(text, pos.character, count);
      const under = new vscode.Range(line, pos.character, line, after);
      await editor.edit((b) => b.replace(under, swapCase(text.slice(pos.character, after))));
      // Vim ~ moves right past the toggled chars, clamped at the last char of the line.
      const next = after >= text.length ? stepCodePoints(text, text.length, -1) : after;
      editor.selection = new vscode.Selection(line, next, line, next);
    }
  }
};

module.exports = {
    applyBracket
  , applyIndent
  , applyCase
  , applyChange
  , applyPaste
  , applyAction
};
