/**
 * @file src/constants/commands.js
 * @description Every VS Code command id the box invokes, and the tables that map a typed key
 *   straight onto those ids: delegated one-shots, display-line motions, indent / scroll / fold
 *   commands. All ids are transcribed from the installed build or vscode.d.ts, never recalled.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

const { table } = require("../utils/table.js");

/**
 * VS Code command ids invoked by the operators and the box lifecycle. The workbench.* ids (used by
 * the ex commands) are not in vscode.d.ts -- each was verified present in the installed build's
 * workbench.desktop.main.js before use.
 */
const VSCODE_COMMANDS = Object.freeze({
    JUMP_TO_BRACKET  : "editor.action.jumpToBracket"
  , SELECT_TO_BRACKET: "editor.action.selectToBracket"
  , TO_LOWERCASE     : "editor.action.transformToLowercase"
  , TO_UPPERCASE     : "editor.action.transformToUppercase"
  , JOIN_LINES       : "editor.action.joinLines"
  , SAVE             : "workbench.action.files.save"
  , SAVE_ALL         : "workbench.action.files.saveAll"
  , REVERT_FILE      : "workbench.action.files.revert"
  , CLOSE_EDITOR     : "workbench.action.closeActiveEditor"
  , REVERT_AND_CLOSE : "workbench.action.revertAndCloseActiveEditor"
  , CLOSE_ALL_EDITORS: "workbench.action.closeAllEditors"
  , SPLIT_RIGHT      : "workbench.action.splitEditor"
  , SPLIT_DOWN       : "workbench.action.splitEditorOrthogonal"
  , SET_CONTEXT      : "setContext"
  /**
   * The nine below back the tab / window / buffer ex commands. Every id is transcribed from
   * VSCodeVim v1.32.4 (vendored at reference/vscodevim/{tab,file,only,close}.ts), which runs them
   * in a shipped extension -- not guessed from memory.
   */
  , NEW_UNTITLED: "workbench.action.files.newUntitledFile"
  , CLOSE_OTHERS: "workbench.action.closeOtherEditors"
  , NEXT_EDITOR : "workbench.action.nextEditorInGroup"
  , PREV_EDITOR : "workbench.action.previousEditorInGroup"
  /**
   * B112: was "workbench.action.openEditorAtIndex1". That id DOES exist, but only because the
   * bundle registers it in a loop (`id: N_o + i` for i in 1..9), so it never appears as a string
   * literal and an id sweep reads it as missing. Switched to the plainly-registered
   * `firstEditorInGroup` -- same behavior, and it says what :bf means without a magic number.
   */
  , FIRST_EDITOR   : "workbench.action.firstEditorInGroup"
  , LAST_EDITOR    : "workbench.action.lastEditorInGroup"
  , JOIN_ALL_GROUPS: "workbench.action.joinAllGroups"
  /**
   * B112: was "workbench.action.maximizeEditor", which is genuinely absent -- the build registers
   * only `maximizeEditorHideSidebar`, so `:on` had been a silent no-op since B104. The shipped id
   * is the toggle form. `:on` joins every group first, so a toggle lands on "maximized" from a
   * multi-group layout, which is the behavior Vim's :only describes.
   */
  , MAXIMIZE_EDITOR: "workbench.action.toggleMaximizeEditorGroup"
  , GO_DEFINITION  : "editor.action.revealDefinition"
  , GO_DECLARATION : "editor.action.revealDeclaration"
  /**
   * B112. All verified present in the installed build's workbench.desktop.main.js (1.129.1),
   * the same way the ids above were -- read out of the bundle, never recalled. NEXT_TAB is NOT
   * the same id as NEXT_EDITOR above: `:tabn` moves within the group (Vim tab page ~ editor
   * group), while Vim's `gt` walks the whole tab bar, which is VS Code's plain nextEditor.
   */
  , SHOW_HOVER : "editor.action.showHover"
  , GOTO_OFFSET: "workbench.action.gotoOffset"
  , OPEN_LINK  : "editor.action.openLink"
  , NEXT_TAB   : "workbench.action.nextEditor"
  , PREV_TAB   : "workbench.action.previousEditor"
  // Takes the index as a bare number argument, zero-based: the bundle's handler is
  // `getEditorByIndex(t)` guarded by `typeof t == "number"`. Used by `{count}gt`.
  , OPEN_EDITOR_AT_INDEX: "workbench.action.openEditorAtIndex"
});

/**
 * One-shot commands that delegate straight to a VS Code command (B112). Each cites the index.txt
 * row it implements. They resolve to `kind: "action"` because none has a parse-time coordinate --
 * VS Code answers at Enter -- so none of them previews, exactly like `gd` / `gD`.
 */
const DELEGATED = table({
    ZZ: { note    : "Save the file and close the editor." // index.txt:374
      , commands: ["workbench.action.files.save", "workbench.action.closeActiveEditor"] }
  , ZQ: { note    : "Close the editor without saving." // :375
      , commands: ["workbench.action.revertAndCloseActiveEditor"] }
  , gt: { note: "Go to the next editor.", commands: ["workbench.action.nextEditor"] } // :804
  , gT: { note: "Go to the previous editor.", commands: ["workbench.action.previousEditor"] } // :764
  // Vim looks the word up with 'keywordprg' (man, :help ...); VS Code's equivalent answer for
  // "what is this identifier" is the hover, which the language server fills in.
  , K: { note    : "Show the hover for the word under the cursor." // :349
      , commands: ["editor.action.showHover"] }
  // Vim's `go` takes a BYTE count; VS Code's Go to Offset prompts for the number instead, so the
  // count is entered there rather than in this box.
  , go: { note    : "Go to a byte offset in the file." // :798
      , commands: ["workbench.action.gotoOffset"] }
  /**
   * gf / gF (:782 / :784) are the weakest match in this table, and the note says so rather than
   * promising Vim's behavior. `editor.action.openLink` acts ONLY on a link VS Code has already
   * detected -- its body reads `r && t.openLinkOccurrence(r)`, so with no occurrence it silently
   * does nothing -- and the default link detector recognises http/https/file URLs, not the bare
   * relative paths (`../lib/util.js`) that Vim's gf is for. It works on a URL, or on a path a
   * language link provider contributed (markdown, imports in some languages). gF cannot add the
   * line-number jump on top, so the two are the same command.
   */
  , gf: { note    : "Open the link under the cursor (a URL, or a path the language marks as a link)."
      , commands: ["editor.action.openLink"] } // :782
  , gF: { note    : "Open the link under the cursor (VS Code does not add Vim's line-number jump)."
      , commands: ["editor.action.openLink"] } // :784
  /**
   * o / O open a line and start insert (index.txt:414 / :355). Only the "open a line" half needs
   * doing -- VS Code is always inserting -- and it leaves the cursor on the new line, ready to
   * type, which is the whole observable behavior. Unlike I / A these CHANGE THE BUFFER, so they
   * stay actions (no preview) rather than resolving to a coordinate.
   */
  , o: { note    : "Open a new line below and put the cursor there." // :414
      , commands: ["editor.action.insertLineAfter"] }
  , O: { note    : "Open a new line above and put the cursor there." // :355
      , commands: ["editor.action.insertLineBefore"] }
  /**
   * gn / gN select the next / previous match of the last search (index.txt:796 / :758). VS Code's
   * find-match selection is the same idea; it reads the FIND widget's term rather than this box's
   * remembered pattern, which is a divergence worth knowing but the closer of the two behaviors.
   * Vim's g- / g+ walk the undo TREE by timestamp (index.txt:739 / :737), which is how Vim reaches
   * a branch that plain `u` / CTRL-R cannot. VS Code keeps a LINEAR undo history with no branches,
   * so on that history the two are the same traversal -- the divergence only shows on a document
   * where Vim would have branched, which VS Code cannot represent in the first place.
   */
  , "g-": { note: "Go to an older state of the file (undo).", commands: ["undo"] } // :739
  , "g+": { note: "Go to a newer state of the file (redo).", commands: ["redo"] } // :737
  , gn  : { note    : "Select the next match of the current find." // :796
      , commands: ["editor.action.moveSelectionToNextFindMatch"] }
  , gN: { note    : "Select the previous match of the current find." // :758
      , commands: ["editor.action.moveSelectionToPreviousFindMatch"] }
  // gv reselects the last Visual area (:806). VS Code keeps no such history, but "expand the
  // selection back out" is the nearest live equivalent and is what a user reaches for.
  , gv: { note    : "Expand the selection (Vim reselects the last visual area)." // :806
      , commands: ["editor.action.smartSelect.expand"] }
  // [c / ]c jump between CHANGES (:659 / :700) -- Vim means diff hunks, VS Code means the same
  // thing against the file's SCM baseline, so these line up unusually well.
  , "[c": { note    : "Go to the previous change."
      , commands: ["workbench.action.editor.previousChange"] }
  , "]c": { note: "Go to the next change.", commands: ["workbench.action.editor.nextChange"] }
  // [f / ]f are stated as exact synonyms of gf (:664 / :704), so they carry gf's caveat too.
  , "[f": { note    : "Open the link under the cursor (a URL, or a path the language marks as a link)."
      , commands: ["editor.action.openLink"] }
  , "]f": { note    : "Open the link under the cursor (a URL, or a path the language marks as a link)."
      , commands: ["editor.action.openLink"] }
});

/**
 * DISPLAY-LINE motions (B112): `g0` `g^` `g$` `gj` `gk` `gm` move by what is drawn on screen, not
 * by buffer line (index.txt:729-794). With 'wrap' off they equal `0` `^` `$` `j` `k`, which is why
 * they are easy to mis-implement as aliases -- but with word-wrap ON a buffer line occupies several
 * screen rows and the two disagree. They cannot be resolved to a coordinate here at all: only the
 * editor knows where its wrap points are, so each delegates to `cursorMove` with the wrapped-line
 * argument. Every `to` value below is transcribed from the command's own metadata in the installed
 * build's workbench.desktop.main.js (1.129.1), not recalled.
 */
const DISPLAY_LINE = table({
    g0  : { note: "Go to the start of the screen line.", to: "wrappedLineStart" } // :740
  , "g^": { note: "Go to the first non-blank of the screen line." // :770
      , to  : "wrappedLineFirstNonWhitespaceCharacter" }
  , "g$": { note: "Go to the end of the screen line.", to: "wrappedLineEnd" } // :729
  , gm  : { note: "Go to the middle of the screen line.", to: "wrappedLineColumnCenter" } // :794
  , gj  : { note: "Go down one screen line.", to: "down", by: "wrappedLine" } // :790
  , gk  : { note: "Go up one screen line.", to: "up", by: "wrappedLine" } // :792
});

const INDENT_COMMANDS = table({
    indent : "editor.action.indentLines"
  , outdent: "editor.action.outdentLines"
  , format : "editor.action.formatSelection"
  , fold   : "editor.createFoldingRangeFromSelection"
});

/**
 * Self-contained one-shot Vim commands: they act once at the cursor with NO target/motion, so they
 * need no persistent mode. x/X delete char(s), J/gJ join lines, ~ toggles case of char(s), r{char}
 * replaces char(s), and zt/zz/zb/z./z- scroll the window. All take a [count]. (Uppercase
 * D/C/Y are rewritten to d$/c$/yy, count included.)
 */
const ACTION_KIND = table({ x: "deleteCharUnder", X: "deleteCharBefore", J: "joinLines" });

/**
 * z scroll commands: where the target line goes; the dot / dash forms also move the cursor to the
 * line's first non-blank, the letter forms keep the cursor (scroll.txt:113-144). z<CR> (top + move)
 * cannot be typed in the box -- Enter submits -- so `zt` is the only top form.
 * `+` is z+'s spot: top of the window WITH the cursor moved to the first non-blank, which is what
 * separates it from plain `zt` (same spot, cursor column untouched).
 */
const SCROLL_SPOT = table(
  { t: "top", z: "center", b: "bottom", ".": "center", "-": "bottom", "+": "top" });

/**
 * z HORIZONTAL scroll (scroll.txt:154-162). These take NO count here even though Vim counts them:
 * VS Code's scrollLeft / scrollRight are registered with a hard-coded `value: 2` columns and accept
 * no argument, so N would be off by a factor of two -- a wrong magnitude is worse than a missing
 * count. `editorScroll` does take {to, by, value} and its internal RawDirection has Left/Right, but
 * its PUBLISHED schema restricts `to` to ["up","down"], so driving it sideways means building on
 * something VS Code has not declared. Stated, not guessed.
 * zH / zL (half a screenwidth) and ze / zs (position the cursor at one edge) have no VS Code
 * primitive at all -- nothing exposes the screen width or a horizontal reveal -- so they stay out.
 */
const Z_SCROLL_H = table({
    h: { note: "Scroll the view left (VS Code's step is 2 columns).", command: "scrollLeft" }
  , l: { note: "Scroll the view right (VS Code's step is 2 columns).", command: "scrollRight" }
});

/**
 * z FOLD commands (fold.txt): each maps to a VS Code folding command whose id was verified present
 * in the installed build. Most take no count, matching Vim. The exception is the foldlevel pair
 * zm / zr, which ARE counted: `editor.fold` documents a `levels` argument inline in the bundle
 * ("'levels': Number of levels to fold", with schema {levels:{type:"number"}, direction:...}), so
 * a previous comment here claiming that shape was "not verifiable from the shipped bundle" was
 * simply wrong -- it is printed in the command's own metadata.
 */
const FOLD_COMMANDS = table({
    o: { note: "Open the fold under the cursor.", command: "editor.unfold" } // :364
  , O: { note   : "Open the fold under the cursor, recursively."
      , command: "editor.unfoldRecursively" } // :369
  , c: { note: "Close the fold under the cursor.", command: "editor.fold" } // :375
  , C: { note   : "Close the fold under the cursor, recursively."
      , command: "editor.foldRecursively" } // :381
  , a: { note: "Toggle the fold under the cursor.", command: "editor.toggleFold" } // :388
  , R: { note: "Open every fold.", command: "editor.unfoldAll" } // :431
  , M: { note: "Close every fold.", command: "editor.foldAll" } // :424
  , E: { note   : "Remove every manually created fold."
      , command: "editor.removeManualFoldingRanges" } // :353
  , j: { note   : "Move down to the start of the next fold."
      , command: "editor.gotoNextFold" } // :470
  , k: { note   : "Move up to the end of the previous fold."
      , command: "editor.gotoPreviousFold" } // :476
  , v: { note   : "Open just enough folds to reveal the cursor line."
      , command: "editor.unfold" } // :404
  /**
   * B112 -- the rest of the z fold family. Every id verified present in the installed build's
   * workbench.desktop.main.js (1.129.1). Where Vim manipulates 'foldlevel' / 'foldenable' (its
   * own options) VS Code has no equivalent SETTING, only the resulting action, so the note names
   * what actually happens rather than claiming an option the editor does not have.
   */
  , A: { note   : "Toggle the fold under the cursor, recursively." // :835
      , command: "editor.toggleFoldRecursively" }
  , D: { note   : "Remove the manually created folds under the cursor." // :838
      , command: "editor.removeManualFoldingRanges" }
  , F: { note   : "Create a fold from the current selection." // :840
      , command: "editor.createFoldingRangeFromSelection" }
  , d: { note   : "Remove the manually created fold under the cursor." // :857
      , command: "editor.removeManualFoldingRanges" }
  , f: { note   : "Create a fold from the current selection." // :861
      , command: "editor.createFoldingRangeFromSelection" }
  /**
   * Vim's zn / zN / zi switch 'foldenable' off / on / toggle. VS Code has no such flag; the
   * observable effect of turning folding off is that every fold opens, and of turning it back on
   * that they close again, so these map to the unfold-all / fold-all pair.
   */
  , n: { note   : "Open every fold (Vim turns folding off)." // :871
      , command: "editor.unfoldAll" }
  , N: { note   : "Close every fold (Vim turns folding back on)." // :847
      , command: "editor.foldAll" }
  , i: { note   : "Open every fold (Vim toggles folding)." // :865
      , command: "editor.unfoldAll" }
  , X: { note   : "Close every fold (Vim re-applies 'foldlevel')." // :851
      , command: "editor.foldAll" }
  /**
   * zm / zr change 'foldlevel' by one -- a WINDOW-WIDE, one-level move (fold.txt:418-419,
   * index.txt:870/:875). They were briefly aliased to foldRecursively / unfoldRecursively, which
   * is cursor-local and all-levels: the wrong axis on both counts, and it made zm identical to zC
   * while their notes claimed different things. `levels` is the argument that actually means
   * this, and B112's [id, args] plumbing is what carries it, so these are counted commands.
   */
  , m: { note: "Fold one level.", command: "editor.fold", args: { levels: 1 } } // :870
  , r: { note: "Unfold one level.", command: "editor.unfold", args: { levels: 1 } } // :875
});

module.exports = {
    VSCODE_COMMANDS
  , DELEGATED
  , DISPLAY_LINE
  , INDENT_COMMANDS
  , ACTION_KIND
  , SCROLL_SPOT
  , Z_SCROLL_H
  , FOLD_COMMANDS
};
