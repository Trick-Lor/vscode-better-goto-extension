/**
 * @file src/constants/ex-tables.js
 * @description The ex-command vocabulary: the : name aliases, what each name does, the range and destination verbs, and the address patterns.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";
const { table } = require("../utils/table.js");
const { VSCODE_COMMANDS } = require("./commands.js");

// Vim ex commands, reachable with ONE leading ":" like Vim (`:w`; B105 -- `::w` is Invalid). Only the file /
// window commands a one-shot box can run; names per the vendored help (editing.txt:931 :w,
// :1011 :wa, :1151 :q, :1180 :wq, :1201 :x, :1227 :qa; windows.txt:157 :sp, :190 :vs;
// tabpage.txt for the :tab family; windows.txt for the :b family).
// NOT here, each for a stated reason:
// - `:qa!` / `:bd!`  -- discarding ALL editors needs a LOOP of revertAndClose (that is how
//   VSCodeVim does it, reference/vscodevim/quit.ts:49-56); this table only runs a fixed command
//   list, so a half-done version would silently close some editors and stop.
// - `:e` (no bang)   -- Vim REFUSES it on a modified buffer (E37); VS Code's only reload is
//   `revert`, which DISCARDS. Mapping them would destroy changes on a command Vim treats as safe.
//   `:e!` (explicitly forcing) stays.
// - `:noh`           -- VSCodeVim clears ITS OWN highlight state (reference/vscodevim/nohl.ts);
//   there is no VS Code command, and this box owns no search highlight to clear.
// - `:n` `:N` `:prev` `:rew` `:wn` `:wp` `:args` -- Vim's ARGUMENT LIST has no VS Code analog;
//   VSCodeVim lists them and leaves them unimplemented too (exCommandParser.ts).
// - `:ls` `:tabs` `:reg` -- list-printing commands; the box shows one label, not a pane.
// - `:tabm` `:b {name}`  -- take arguments this table cannot express.
const EX_ALIAS = table({ write  : "w", wall   : "wa", quit   : "q", "quit!": "q!", qall   : "qa"
    , "wq!"  : "wq", x      : "wq", xit    : "wq", "edit!": "e!", split  : "sp", vsplit : "vs"
    , u      : "undo", un     : "undo", red    : "redo"
    // save-all + quit-all family (editing.txt :wqa/:xa) and the long spellings of what exists
    , "w!"   : "w", wqall  : "wqa", xa     : "wqa", xall   : "wqa", exi    : "wq", exit   : "wq"
    , quita  : "qa", quitall: "qa"
    // tab family (tabpage.txt) -- VS Code has no tab pages, so a Vim tab maps to an EDITOR
    , tabedit    : "tabe", tabnew     : "tabe", tabclose   : "tabc", tabonly    : "tabo", tabnext    : "tabn"
    , tabprevious: "tabp", tabfirst   : "tabfir", tablast    : "tabl"
    // buffer family (windows.txt) -- VSCodeVim routes :bn/:bp/:bf/:bl through the SAME parsers as
    // the tab commands (exCommandParser.ts:109-114 vs :538-543), so they share behavior here too.
    , bnext: "bn", bprevious: "bp", bfirst: "bf", blast: "bl", bdelete: "bd"
    // window family (windows.txt)
    , close: "clo", only: "on", vnew: "vne", enew: "ene"
    // B112: the remaining SPELLINGS Vim accepts for commands this box already runs. index.txt lists
    // each as its own row, so without these the box rejects a name a Vim user would reasonably type.
    // :bN / :bNext are the previous buffer (:bp); :brewind is the first (:bf); :bunload and
    // :bwipeout both close (:bd); :earlier / :later are undo / redo (they take a count in Vim,
    // which this box does not carry -- a divergence, not a silent one).
    // Every entry points DIRECTLY at an EX_ACTIONS key: the lookup is one level
    // (`EX_ACTIONS[EX_ALIAS[spec] || spec]`), so an alias pointing at another alias resolves to
    // nothing.
    , bN      : "bp", bNext   : "bp", brewind : "bf", br      : "bf", bunload : "bd", bun     : "bd"
    , bwipeout: "bd", bw      : "bd", earlier : "undo", ea      : "undo", later   : "redo", lat     : "redo"
    , isplit  : "isp", "set"   : "se" });
const EX_ACTIONS = table({
      w: { note    : "Save the file."
             , commands: [VSCODE_COMMANDS.SAVE] }
    , wa: { note    : "Save all files."
             , commands: [VSCODE_COMMANDS.SAVE_ALL] }
    , q: { note    : "Close the editor."
             , commands: [VSCODE_COMMANDS.CLOSE_EDITOR] }
    , "q!": { note    : "Discard the changes and close the editor."
             , commands: [VSCODE_COMMANDS.REVERT_AND_CLOSE] }
    , qa: { note    : "Close all editors."
             , commands: [VSCODE_COMMANDS.CLOSE_ALL_EDITORS] }
    , wq: { note    : "Save the file and close the editor."
             , commands: [VSCODE_COMMANDS.SAVE, VSCODE_COMMANDS.CLOSE_EDITOR] }
    , "e!": { note    : "Reload the file, discarding the changes."
             , commands: [VSCODE_COMMANDS.REVERT_FILE] }
    , sp: { note    : "Split the editor down."
             , commands: [VSCODE_COMMANDS.SPLIT_DOWN] }
    , vs: { note    : "Split the editor right."
             , commands: [VSCODE_COMMANDS.SPLIT_RIGHT] }
    // undo.txt:22 / :31 -- Vim's redo is CTRL-R (untypeable here), so `:redo` is the way in.
    , undo: { note: "Undo the last change.", commands: ["undo"] }
    , redo: { note: "Redo the undone change.", commands: ["redo"] }
    // editing.txt :wqa -- the box already had :wa and :qa separately; the combined form was missing.
    , wqa: { note    : "Save all files and close all editors."
             , commands: [VSCODE_COMMANDS.SAVE_ALL, VSCODE_COMMANDS.CLOSE_ALL_EDITORS] }
    // tab family. A Vim tab page holds a window layout; VS Code has no equivalent, so each maps to
    // the EDITOR action VSCodeVim uses (reference/vscodevim/tab.ts) -- named for what it does here.
    , tabe: { note    : "Open a new editor."
               , commands: [VSCODE_COMMANDS.NEW_UNTITLED] }
    , tabc: { note    : "Close the editor."
               , commands: [VSCODE_COMMANDS.CLOSE_EDITOR] }
    , tabo: { note    : "Close every other editor."
               , commands: [VSCODE_COMMANDS.CLOSE_OTHERS] }
    , tabn: { note    : "Go to the next editor."
               , commands: [VSCODE_COMMANDS.NEXT_EDITOR] }
    , tabp: { note    : "Go to the previous editor."
               , commands: [VSCODE_COMMANDS.PREV_EDITOR] }
    , tabfir: { note    : "Go to the first editor."
               , commands: [VSCODE_COMMANDS.FIRST_EDITOR] }
    , tabl: { note    : "Go to the last editor."
               , commands: [VSCODE_COMMANDS.LAST_EDITOR] }
    // buffer family -- same editor actions, Vim's buffer wording.
    , bn: { note    : "Go to the next editor."
               , commands: [VSCODE_COMMANDS.NEXT_EDITOR] }
    , bp: { note    : "Go to the previous editor."
               , commands: [VSCODE_COMMANDS.PREV_EDITOR] }
    , bf: { note    : "Go to the first editor."
               , commands: [VSCODE_COMMANDS.FIRST_EDITOR] }
    , bl: { note    : "Go to the last editor."
               , commands: [VSCODE_COMMANDS.LAST_EDITOR] }
    , bd: { note    : "Close the editor."
               , commands: [VSCODE_COMMANDS.CLOSE_EDITOR] }
    // window family (windows.txt :clo, :on, :new, :vnew; editing.txt :enew)
    , clo: { note    : "Close the editor."
               , commands: [VSCODE_COMMANDS.CLOSE_EDITOR] }
    // VSCodeVim also runs closePanel here (reference/vscodevim/only.ts:10). Left OUT on purpose:
    // Vim's `:only` closes other WINDOWS, and the VS Code panel is not one -- killing a running
    // terminal is a surprise the command never promised. Editor groups are joined and maximized.
    , on: { note    : "Keep only this editor."
               , commands: [VSCODE_COMMANDS.JOIN_ALL_GROUPS, VSCODE_COMMANDS.MAXIMIZE_EDITOR] }
    , "new": { note    : "Split down and open a new editor."
               , commands: [VSCODE_COMMANDS.SPLIT_DOWN, VSCODE_COMMANDS.NEW_UNTITLED] }
    , vne: { note    : "Split right and open a new editor."
               , commands: [VSCODE_COMMANDS.SPLIT_RIGHT, VSCODE_COMMANDS.NEW_UNTITLED] }
    , ene: { note    : "Open a new empty editor."
               , commands: [VSCODE_COMMANDS.NEW_UNTITLED] }
    // B112 second pass. Triaging all 566 missing ex commands against "is there a concrete VS Code
    // command for this?" left only these two: the rest are scripting (:function :autocmd :let), take
    // a filename / pattern ARGUMENT this grammar has no slot for (:b {name}, :edit {file}), print a
    // pane (:ls :reg :jumps), set a Vim OPTION with no counterpart, or already exist under another
    // spelling (:goto == go, :ijump == gd, :earlier == u, :substitute / :move == B098).
    , isp: { note    : "Open the definition under the cursor beside this editor."
               , commands: ["editor.action.revealDefinitionAside"] }
    // Vim's :set changes an option; VS Code's equivalent answer is the Settings UI, so the note
    // says "open Settings" rather than claiming an option was set.
    , se: { note    : "Open Settings."
               , commands: ["workbench.action.openSettings"] }
});

// Range ex commands that act on the span itself (change.txt: :d 76, :y 1099, :j 135, :< 516,
// :> 527, :sort 1913).
const EX_RANGE_VERB = table({
      d       : "delete", "delete": "delete", y       : "yank", yank    : "yank", j       : "join", join    : "join"
    , sor     : "sort", sort    : "sort", ">"     : "indent", "<"     : "outdent"
});
// :m / :t / :co take a DESTINATION address after the name (change.txt :co 1421, :m 1431).
const EX_DEST_VERB = table({ m   : "move", mo  : "move", move: "move"
    , t   : "copy", co  : "copy", copy: "copy" });

// The ex ADDRESS prefix of a range command, as a regex source (shared by every branch below).
const EX_RANGE_SRC = "(%|(?:\\.|\\$|\\d+)(?:,(?:\\.|\\$|\\d+))?)";
// \s* -- `:1,5 s/a/b/` is as legal as `:1,5 d`; only the PATTERN keeps its spaces (B125)
const REGEX_EX_SUB   = new RegExp(`^${EX_RANGE_SRC}?\\s*s(?:ubstitute)?/(.*)$`);
const REGEX_EX_SPAN  = new RegExp(`^${EX_RANGE_SRC}?(>+|<+|[a-z]+)$`);
const REGEX_EX_DEST  = new RegExp(`^${EX_RANGE_SRC}?([a-z]+)(\\.|\\$|\\d+)$`);
const REGEX_EX_BARE  = new RegExp(`^${EX_RANGE_SRC}$`);

module.exports = {
    EX_ALIAS
  , EX_ACTIONS
  , EX_RANGE_VERB
  , EX_DEST_VERB
  , EX_RANGE_SRC
  , REGEX_EX_SUB
  , REGEX_EX_SPAN
  , REGEX_EX_DEST
  , REGEX_EX_BARE
};
