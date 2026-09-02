/**
 * @file src/ui/picker.js
 * @description The command box itself: the context snapshot it hands the parser, the live 2-line label, the preview, history recall, Enter, and Escape.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const vscode = require("vscode");
const { VSCODE_COMMANDS } = require("../constants/commands.js");
const { VERB } = require("../constants/vim-tables.js");
const { NO_VIM_TITLE } = require("../constants/labels.js");
const {
  EMPTY_VALUE
  , CONFIG_SECTION
  , CONTEXT_OPEN
  , HISTORY_SIZE_KEY
  , DEFAULT_HISTORY_SIZE
  , MODE_NO_VIM
} = require("../constants/config.js");
const { searchState, findState, recallState } = require("../state/session.js");
const { pushHistory } = require("../state/history.js");
const { coordinate } = require("../parse/label.js");
const { parseCommand } = require("../parse/command.js");
const { HIGHLIGHT, REVEAL_TYPE } = require("./highlight.js");
const { inclusiveTarget, exclusiveColOne, inclusiveRangeEnd } = require("../apply/position.js");
const { lineSpanSelection } = require("../apply/linewise.js");
const { applyAction } = require("../apply/edit.js");
const { applyCommand } = require("../apply/dispatch.js");
/**
 * Open the command box: dynamic label, live preview of a position target, relative-gutter
 * toggle, Enter to commit (operator x target), Escape to restore.
 *
 * @param {vscode.TextEditor} editor
 * @param {string} mode   "default" | "no-vim" -- gates the grammar (logic-classification.md)
 * @param {boolean} preview  false -> the editor stays put while typing; the label still describes
 *                           the destination, and Enter behaves identically (B116)
 */
const showPicker = (editor, mode, preview) => {
  const savedSelection      = editor.selection;
  const originalLineNumbers = editor.options.lineNumbers;
  const wasRelative         = originalLineNumbers === vscode.TextEditorLineNumbersStyle.Relative;
  const highlight           = vscode.window.createTextEditorDecorationType(HIGHLIGHT);
  const visible             = editor.visibleRanges;

  const ctx = {
        totalLines    : editor.document.lineCount
        , currentLine   : savedSelection.active.line
        , currentChar   : savedSelection.active.character
        , lineLength    : (lineIndex) => editor.document.lineAt(lineIndex).text.length
        , lineText      : (lineIndex) => editor.document.lineAt(lineIndex).text
        , viewportTop   : visible.length ? visible[0].start.line : savedSelection.active.line
        , viewportBottom: visible.length
          ? visible[visible.length - 1].end.line : savedSelection.active.line
        // VS Code's word separators so w/b/e match the built-in word commands (see charClass).
        , wordSeparators: vscode.workspace.getConfiguration("editor", editor.document.uri)
          .get("wordSeparators")
        // the active mode gates which grammar half parseCommand accepts (default / no-vim).
        , mode: mode
        // the last committed search, so `n` / `N` resolve without re-typing the pattern (B108)
        , lastSearch: searchState
        // the last committed f/F/t/T, so `,` can repeat it in the opposite direction (B110)
        , lastFind: findState
    };

  // Built-in shows absolute numbers while choosing when the gutter is in relative mode.
  if (wasRelative) editor.options = { lineNumbers: vscode.TextEditorLineNumbersStyle.On };

  const picker = vscode.window.createQuickPick();
  // Announce the disabled half up front so a rejected Vim command reads as a mode, not a bug.
  if (mode === MODE_NO_VIM) picker.title = NO_VIM_TITLE;
  // expose to the history commands; reset the browse position for this open
  recallState.picker  = picker;
  recallState.index   = -1;
  recallState.stashed = EMPTY_VALUE;

  let accepted       = false;
  let command        = null;
  let bracketMoved   = false; // a bracket preview has the cursor at the matching bracket
  let selectionPreviewed = false; // a range preview holds an A->B selection
  let renderSeq      = 0;     // monotonic token: a newer keystroke supersedes an in-flight render
  let hidden         = false; // the box closed; an in-flight render must not touch it (B118)

  /**
   * Scroll the target into view -- a no-op while preview is off (B116).
   *
   * @param {vscode.Range} range
   * @returns {void}
   */
  const reveal = (range) => {
    if (preview) editor.revealRange(range, REVEAL_TYPE);
  };

  /**
   * Whole-line highlight the given ranges, or clear the decoration. Passing [] is how every
   * non-position branch clears it, so preview-off simply always clears (B116).
   *
   * @param {vscode.Range[]} ranges
   * @returns {void}
   */
  const mark = (ranges) => {
        editor.setDecorations(highlight, preview ? ranges : []);
  };

  /**
   * Re-parse on each keystroke: update the 2-line label and preview the target. A bracket has no
   * parse-time coordinate, so it is previewed by running VS Code's own jumpToBracket (correct,
   * tokenizer-aware) and leaving the cursor there; the TOP coordinate is read from it.
   *
   * @param {string} value
   * @returns {Promise<void>}
   */
  const render = async (value) => {
    const token = ++renderSeq; // the bracket branch awaits jumpToBracket; rapid typing overlaps
    if (bracketMoved || selectionPreviewed) {
      editor.selection = savedSelection; // undo any previous bracket / selection preview
      bracketMoved = selectionPreviewed = false;
    }
    command = parseCommand(value, ctx);
    const item = { label: command.label, alwaysShow: true };
    if (command.detail) item.detail = command.detail;
    // the starting cursor sits dimmed to the right of the destination, so a relative jump shows
    // its origin without lengthening the destination label.
    const current = `(current: line ${ctx.currentLine + 1}, char ${ctx.currentChar + 1})`;

    if (command.target.kind === "position") {
      // A select operator (v / V) previews its actual selection span (cursor -> destination),
      // with the SAME inclusive/exclusive corrections onAccept applies (B120).
      if (command.operator === "select" || command.operator === "selectLine") {
        let destination = inclusiveTarget(editor, command.operator, command.target);
        destination = exclusiveColOne(editor, command.operator, savedSelection, destination);
        const at = new vscode.Position(destination.line, destination.character);
        if (preview) {
          editor.selection = command.operator === "selectLine"
            ? lineSpanSelection(editor, savedSelection.active.line, at.line)
            : new vscode.Selection(savedSelection.active, at);
          selectionPreviewed = true;
        }
                mark([]);
                reveal(new vscode.Range(at, at));
                item.description = current;
                picker.items = [item];
                return;
      }
      // Every other operator (go / d / y / c) marks the destination; edits act on Enter.
      const at    = new vscode.Position(command.target.line, command.target.character);
      const range = new vscode.Range(at, at);
            reveal(range);
            mark([range]);
            item.description = current;
            picker.items = [item];
            return;
    }
    if (command.target.kind === "range") {
      const start = new vscode.Position(command.target.start.line
        , command.target.start.character);
      const end   = new vscode.Position(command.target.end.line
        , command.target.end.character);
      if (preview) {
        // a text object's inclusive end and a linewise object's whole lines preview exactly as
        // Enter will select or edit them (B120)
        editor.selection = command.operator === "selectLine" || command.target.linewise
          ? lineSpanSelection(editor, start.line, end.line)
          : new vscode.Selection(start.line, start.character, end.line
            , inclusiveRangeEnd(editor, command.target));
        selectionPreviewed = true;
      }
            mark([]);
            reveal(new vscode.Range(start, end));
            item.description = current;
            picker.items = [item];
            return;
    }
    if (command.target.kind === "bracket") {
      editor.selection = savedSelection; // jump from the original cursor
      // mark the move BEFORE the await: if a newer keystroke or Enter interrupts, the next
      // render's restore or onAccept resets the cursor instead of stranding it.
      bracketMoved = true;
      await vscode.commands.executeCommand(VSCODE_COMMANDS.JUMP_TO_BRACKET);
      // superseded, committed, or hidden mid-flight: the newer restore (or onHide's) may have
      // run BEFORE the jump landed, so undo the landing, then bail off the dead picker (B118).
      if (accepted || hidden || token !== renderSeq) {
        // a LIVE newer preview (bracketMoved re-set / selectionPreviewed) owns the cursor --
        // restoring over it clobbers what it just drew; after hide nothing owns it (B132)
        const newerOwnsCursor = !hidden && (bracketMoved || selectionPreviewed);
        if (!accepted && !newerOwnsCursor && !editor.document.isClosed) {
          editor.selection = savedSelection;
          if (hidden) {
            editor.revealRange(new vscode.Range(savedSelection.active, savedSelection.active)
              , REVEAL_TYPE);
          }
        }
        return;
      }
      const at = editor.selection.active;
      if (at.isEqual(savedSelection.active)) {
        // jumpToBracket did not move -> no bracket here; show a message and block Enter.
        editor.selection = savedSelection;
        bracketMoved = false;
                mark([]);
                command.target = { kind: "none" };
                picker.items = [{ label: "No matching bracket at the cursor", alwaysShow: true }];
                return;
      }
      // Preview off still runs the jump: it is the ONLY way to learn the coordinate the label
      // needs, and the "no matching bracket" check above reads the same move. Put the cursor
      // back at once, so what is left is a brief scroll rather than a held preview (B116).
      if (!preview) {
        editor.selection = savedSelection;
        bracketMoved = false;
      }
      item.label  = `${VERB[command.operator]} ${coordinate(at.line, at.character)}.`;
      item.detail = "Matching bracket";
      item.description = current;
            reveal(new vscode.Range(at, at));
            mark([]);
            picker.items = [item];
            return;
    }
        mark([]); // nothing to preview
        // Invalid / pending / not-found still show the origin, like every valid preview does; the
        // empty help prompt already states "Current Line: ...", so it is skipped (no double).
        if (!command.label.includes("Current Line:")) item.description = current;
        picker.items = [item];
  };

  /**
   * Commit on Enter. No-op while invalid.
   *
   * @returns {Promise<void>}
   */
  const onAccept = async () => {
    // block a re-entrant Enter from re-running the operator
    if (accepted || !command || command.target.kind === "none") {
      return;
    }
    accepted = true;
    // remember this command for Up / Down / 2nd-Ctrl+G recall (dedup-consecutive, capped)
    const historySize = vscode.workspace.getConfiguration(CONFIG_SECTION)
      .get(HISTORY_SIZE_KEY, DEFAULT_HISTORY_SIZE);
    recallState.history = pushHistory(recallState.history, picker.value, historySize);
    const { operator } = command;
    let { target }     = command;

    // a resolved search publishes the pattern it used, so a later `n` / `N` can repeat it.
    // Only a HIT writes here: a miss must not clear the pattern the user is still working with.
    if (target.search) {
      searchState.pattern   = target.search.pattern;
      searchState.backward  = target.search.backward;
      searchState.wholeWord = target.search.wholeWord === true;
    }
    // an f/F/t/T publishes what it searched for, so a later "," can repeat it (B110). A "," /
    // "3," repeat itself never sets target.find (see parseTarget), so this only ever pins to a
    // genuine f/F/t/T -- exactly the "latest f, t, F or T" the spec means (motion.txt:305).
    if (target.find) {
      findState.motion = target.find.motion;
      findState.char   = target.find.char;
    }

    // a self-contained command (x / X / J / ~ / r{char} / z scroll) acts at the cursor with no
    // motion -- handle it before the inclusive/exclusive transforms (they assume a coordinate).
    if (target.kind === "action") {
      editor.selection = savedSelection;
      await applyAction(editor, target);
            picker.hide();
            return;
    }

    // an inclusive forward motion (f / t / E) includes its target char for an operator.
    target = inclusiveTarget(editor, operator, target);
    // an exclusive motion ending in column 1 of a later line pulls back to the prior line end.
    target = exclusiveColOne(editor, operator, savedSelection, target);

    editor.selection = savedSelection; // anchor every action at the original cursor
    await applyCommand(editor, operator, savedSelection, target);
        picker.hide();
  };

  /**
   * Restore the gutter and (on Escape) the original cursor when the picker closes.
   */
  const onHide = () => {
    hidden = true;
    // a fast 2nd Ctrl+G can open the next box before this hide runs -- only the box that
    // still owns the shared state may clear it, or the new box loses recall + its gate (B119)
    if (recallState.picker === picker) {
          vscode.commands.executeCommand(VSCODE_COMMANDS.SET_CONTEXT, CONTEXT_OPEN, false);
          recallState.picker = null; // history commands no-op until the next open
    }
        highlight.dispose();
        // `::q` / `ZZ` close the DOCUMENT (B121); a hidden editor (`gt`, `:tabn`, a split `:q`)
        // keeps its document open while its handle may already be disposed (B131).
        if (!editor.document.isClosed) {
          try {
            if (wasRelative) editor.options = { lineNumbers: originalLineNumbers };
            if (!accepted) {
              editor.selection = savedSelection;
                editor.revealRange(new vscode.Range(savedSelection.active, savedSelection.active)
                    , REVEAL_TYPE);
            }
          } catch {
            // the API has no handle-liveness flag, so the disposed-handle throw IS the
            // "nothing left to restore onto" signal -- absorbing it is the guard (B131)
          }
        }
        picker.dispose();
  };

    picker.onDidChangeValue(render);
    picker.onDidAccept(onAccept);
    picker.onDidHide(onHide);
    render(EMPTY_VALUE);
    // gate the history keybindings (Up / Down / 2nd Ctrl+G recall) while the box is open, so a
    // Ctrl+G re-press recalls instead of falling through to the built-in Go to Line
    vscode.commands.executeCommand(VSCODE_COMMANDS.SET_CONTEXT, CONTEXT_OPEN, true);
    picker.show();  // opens EMPTY (B105) -- nothing to prefill, so nothing to deselect afterwards
};

module.exports = {
    showPicker
};
