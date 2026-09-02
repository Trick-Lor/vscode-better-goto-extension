/**
 * @file extension.js
 * @description Ctrl+G command box: the built-in Go to Line/Column plus Vim-inspired targets
 *   (relative, %, gg/G, $/0, {/}, H/M/L, word motions), the Vim text objects (iw/a{/it ...) and
 *   search (/pat, ?pat, n/N, * # g* g#, gd/gD), the v/V/d/y/c/gu/gU/g~/g?/>/</= operators,
 *   the self-contained one-shots (x/X/D/C/Y/J/gJ/~/r{char}, z scrolls and folds, u, ga), and the
 *   ex commands behind ONE leading ":" (:w, :q, :wq, :5, and the [range] commands :1,19y /
 *   :%s/a/b/g / :1,3m8 ...). The betterGoto.vim setting splits the Vim clone from the
 *   better-goto combos, and betterGoto.enabled hands Ctrl+G back to the built-in box --
 *   each parse result carries an origin tag; docs/logic-classification.md is the contract. Grammar
 *   in docs/features/; status and limits in docs/vim-coverage.md.
 * @scope src
 * @updated-at 2026-09-02
 */
"use strict";

const vscode = require("vscode");

const {
    CONFIG_SECTION
  , HISTORY_SIZE_KEY
  , DEFAULT_HISTORY_SIZE
  , ENABLED_KEY
  , VIM_KEY
  , PREVIEW_KEY
  , MODE_DEFAULT
  , MODE_NO_VIM
} = require("./src/constants/config.js");
const { recallState } = require("./src/state/session.js");
const {
    trimHistory
  , pushHistory
  , historyPrev
  , historyNext
} = require("./src/state/history.js");
const { parseCommand } = require("./src/parse/command.js");
const { applyIndent, applyCase, applyPaste } = require("./src/apply/edit.js");
const { applyCommand } = require("./src/apply/dispatch.js");
const { showPicker } = require("./src/ui/picker.js");

const COMMAND      = "betterGoto.open";
const COMMAND_PREV = "betterGoto.historyPrev"; // recall an older command (Up, or a 2nd Ctrl+G)
const COMMAND_NEXT = "betterGoto.historyNext"; // recall a newer command (Down)
// Verified present in the installed build's workbench.desktop.main.js.
const BUILTIN_GOTO_LINE    = "workbench.action.gotoLine";

/**
 * Register the goto command on extension activation.
 *
 * @param {vscode.ExtensionContext} context
 */
const activate = async (context) => {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND, goto)
        , vscode.commands.registerCommand(COMMAND_PREV, historyPrev)
        , vscode.commands.registerCommand(COMMAND_NEXT, historyNext)
    );
};

const deactivate = async () => { };

/**
 * Ctrl+G entry point.
 *
 * @returns {Promise<void>}
 */
const goto = async () => {
    // The extension's keybinding shadows the built-in Go to Line/Column, so a disabled box must
    // hand it over explicitly -- otherwise Ctrl+G would do nothing.
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (!config.get(ENABLED_KEY, true)) {
        await vscode.commands.executeCommand(BUILTIN_GOTO_LINE);
        return;
    }
    // Apply a shrunk historySize NOW, not at the next commit: entries the setting just dropped are
    // still in memory, and Up would keep reaching them until something else was committed (B117).
    // This is also what makes 0 an immediate off switch rather than a delayed one.
    recallState.history = trimHistory(recallState.history
        , config.get(HISTORY_SIZE_KEY, DEFAULT_HISTORY_SIZE));
    const mode = config.get(VIM_KEY, true) ? MODE_DEFAULT : MODE_NO_VIM;
    // The built-in runs quickAccess.show(":") with no editor check at all, so it opens its picker
    // even where nothing is editable (Settings UI, Search view). Hand over instead of warning --
    // the box shadows Ctrl+G everywhere the built-in fires, so it must not be a dead key there.
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        await vscode.commands.executeCommand(BUILTIN_GOTO_LINE);
        return;
    }
    showPicker(editor, mode, config.get(PREVIEW_KEY, true));
};


module.exports = {
    activate
    , deactivate
    , parseCommand   // exported so the parse logic can be unit-tested in isolation
    , pushHistory    // exported so the history dedup/cap logic can be unit-tested in isolation
    , trimHistory    // the shrink-on-open cap (B117), same reason -- it is pure and assertable
    // applyPaste is an APPLY-path function, exported for the same reason: the suite could otherwise
    // only reach parsing, which is how B111's put shipped with every runtime branch untested.
    , applyPaste
    // Same reason again, and a sharper lesson (B114): the whole indent / format / case / fold
    // family shipped from B113 SELECTING the right span and then running no command at all, and
    // every parse assertion stayed green because the target and the label were both correct. An
    // apply-path fault is invisible to a parse suite by construction, so these two are exported to
    // make that half testable rather than trusted.
    , applyIndent
    , applyCase
    // applyCommand is the ROUTING itself, and the routing is where B114's defect lived. Exporting
    // the helpers alone was not enough: a test that calls applyIndent directly passes whether or
    // not the dispatch ever reaches it (verified -- reverting the arm order left such a test green).
    , applyCommand
};
