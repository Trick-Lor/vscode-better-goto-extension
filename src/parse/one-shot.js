/**
 * @file src/parse/one-shot.js
 * @description Self-contained commands that need no target: the z scrolls, x/J/~/r and friends, the put family, and ga.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const {
  ACTION_KIND
  , DELEGATED
  , DISPLAY_LINE
  , FOLD_COMMANDS
  , SCROLL_SPOT
  , VSCODE_COMMANDS
  , Z_SCROLL_H
} = require("../constants/commands.js");
const { REGEX_PASTE } = require("../constants/patterns.js");
const { actionNote } = require("./label.js");

// A z scroll command: `line` is the 1-based [count] line (0 = no count = the cursor line).
const scrollCommand = (key, line) => {
  const move  = key === "." || key === "-" || key === "+";
  const which = line ? `line ${line}` : "the current line";
  const note  = `Scroll: ${which} to the ${SCROLL_SPOT[key]} of the window`
        + (move ? ", cursor to its first non-blank." : ".");
  return { operator: "go", label   : note, detail  : note
        , target  : { kind: "action", action: "scroll", spot: SCROLL_SPOT[key], move, line } };
};
const actionCommand = (action, count, char) => {
  const note = actionNote(action, count, char);
  return { operator: "go", label   : note, detail  : note
        , target  : { kind: "action", action, count, char } };
};

/**
 * A PUT command (change.txt:1109-1178). `p` puts after the cursor, `P` before; `gp` / `gP` differ
 * only in leaving the cursor just after the new text; the bracket forms adjust the pasted indent to
 * the current line, and of those only `]p` puts AFTER -- `[p`, `[P` and `]P` all put BEFORE
 * (:1168-1178). Resolves to an action: a put has no target coordinate, so it never previews.
 *
 * @param {string} prefix  "" | "g" | "[" | "]" (undefined when the spec had no prefix)
 * @param {string} key     "p" | "P"
 * @param {number} count
 * @returns {object}
 */
const pasteCommand = (prefix, key, count) => {
  const indent      = prefix === "[" || prefix === "]";
  const after       = indent ? (prefix === "]" && key === "p") : key === "p";
  const cursorAfter = prefix === "g";
  const times       = count > 1 ? ` ${count} times` : "";
  const note        = `Put the clipboard ${after ? "after" : "before"} the cursor${times}`
        + (indent ? ", indent matched to this line." : cursorAfter
          ? ", cursor after the new text." : ".");
  return { operator: "go", label   : note, detail  : note
        , target  : { kind  : "action", action: "paste", count, after, indent, cursorAfter
            , origin: "vim" } };
};

// `ga` -- print the code of the character under the cursor (various.txt:53). Informational only:
// Vim just prints it, so this resolves to a message (Enter does nothing), never an edit.
const charCodeCommand = (ctx) => {
  const text = ctx.lineText(ctx.currentLine);
  const char = text.codePointAt(ctx.currentChar);
  // `origin` is stated explicitly: the result is a MESSAGE (kind "none"), which carries no target
  // to classify, so the mode gate would otherwise let this Vim command through in "no-vim".
  if (char === undefined) {
    return { operator: "go", label   : "No character under the cursor."
            , origin  : "vim", target  : { kind: "none" } };
  }
  const glyph = String.fromCodePoint(char);
  const note  = `<${glyph}>  ${char},  Hex ${char.toString(16)},  Octal ${char.toString(8)}`;
  return { operator: "go", label   : note, detail  : "The character under the cursor (Vim ga)."
        , origin  : "vim", target  : { kind: "none" } };
};

// Recognise a self-contained command spec and return a finished command, else null. Called from
// parseCommand before the operator cascade, so x / J / gJ / ~ / r{char} / z scrolls / z folds / u /
// ga never reach the motion parser. Bare `r` / `z` pend for their second key. The r{char} regexes
// carry /u so an astral {char} (emoji) matches as ONE character, not a surrogate half.
const standaloneCommand = (raw, ctx) => {
  const tilde = raw.match(/^([1-9]\d*)?~$/);
  if (tilde) return actionCommand("toggleCaseChar", tilde[1] ? parseInt(tilde[1], 10) : 1);
  const gj = raw.match(/^([1-9]\d*)?gJ$/);
  if (gj) return actionCommand("joinNoSpace", gj[1] ? parseInt(gj[1], 10) : 1);
  const cmd = raw.match(/^([1-9]\d*)?([xXJ])$/);
  if (cmd) return actionCommand(ACTION_KIND[cmd[2]], cmd[1] ? parseInt(cmd[1], 10) : 1);
  const paste = raw.match(REGEX_PASTE);
  if (paste) return pasteCommand(paste[2], paste[3], paste[1] ? parseInt(paste[1], 10) : 1);
  if (raw === "ga") return charCodeCommand(ctx);
  // gd / gD -- jump to the definition / declaration of the identifier under the cursor
  // (pattern.txt:*gd* *gD*). Vim scans the file itself; VS Code answers from the language server,
  // which is strictly better, so these delegate. Both ids verified present in the installed
  // build's workbench.desktop.main.js (1.129.1).
  if (raw === "gd" || raw === "gD") {
    const declaration = raw === "gD";
    return { operator: "go"
            , label   : `Go to the ${declaration ? "declaration" : "definition"} under the cursor.`
            , detail  : `Vim ${raw} (pattern.txt) -- resolved by the language server, not a text scan.`
            , target  : { kind    : "action", action  : "ex", origin  : "vim"
                , commands: [declaration
                  ? VSCODE_COMMANDS.GO_DECLARATION : VSCODE_COMMANDS.GO_DEFINITION] } };
  }
  // `{count}gt` is ABSOLUTE, not a repeat: tabpage.txt:210 reads "Go to tab page {count}. The
  // first tab page has number one." It cannot ride the repeat path below, which would open the
  // count-th NEXT editor instead of the count-th editor. openEditorAtIndex takes a bare number and
  // is zero-based -- the bundle's handler is `getEditorByIndex(t)` with `typeof t == "number"` --
  // so Vim's one-based count is passed as count - 1.
  const absoluteTab = raw.match(/^([1-9]\d*)gt$/);
  if (absoluteTab) {
    const nth = parseInt(absoluteTab[1], 10);
    return { operator: "go"
            , label   : `Go to editor ${nth} in the tab bar.`
            , detail  : `Vim ${raw} (tabpage.txt:210) -- run by VS Code.`
            , target  : { kind    : "action", action  : "ex", origin  : "vim"
                , commands: [[VSCODE_COMMANDS.OPEN_EDITOR_AT_INDEX, nth - 1]] } };
  }
  // ZZ / ZQ / gt / gT / K / go / gf / gF -- delegate to a VS Code command (B112, see DELEGATED).
  // A count repeats the command N times, and is accepted only where the vendored spec states one:
  // `[c` / `]c` read "cursor N times backwards/forward" (index.txt:659,700); `gn` / `gN` are "like
  // `n`" (visual.txt:112,124) and `n` / `N` repeat "N times" (index.txt:413,353); `gT` goes
  // "{count} tab pages back" (tabpage.txt:222). ZZ ZQ K gf gF state none, so `2ZZ` stays Invalid
  // rather than silently behaving as `ZZ`. NOTE: index.txt's note column is NOT a count marker --
  // its legend (:201) reads "1 = cursor movement command; 2 = can be undone/redone". Counts come
  // from the description text or the command's own help entry.
  const delegated = raw.match(/^([1-9]\d*)?(.*)$/);
  // `o` / `O` state "repeat N times" (index.txt:414,355). Vim repeats the TYPED text; the box has
  // no typed text, so N repeats reduce to N new lines -- the same observable result for the part
  // the box is responsible for.
  const repeatable = new Set(["[c", "]c", "gn", "gN", "gT", "o", "O", "g-", "g+"]);
  const delegateKey = delegated && DELEGATED[delegated[2]] ? delegated[2] : null;
  if (delegateKey && (!delegated[1] || repeatable.has(delegateKey))) {
    const { note, commands } = DELEGATED[delegateKey];
    const count = delegated[1] ? parseInt(delegated[1], 10) : 1;
    const runs  = count > 1 ? Array.from({ length: count }, () => commands).flat() : commands;
    return { operator: "go"
            , label   : count > 1 ? `${note.replace(/\.$/, "")}, ${count} times.` : note
            , detail  : `Vim ${raw} -- run by VS Code.`
            , target  : { kind: "action", action: "ex", origin: "vim", commands: runs } };
  }
  // g0 / g^ / g$ / gm / gj / gk -- screen-line motions, count-aware (B112, see DISPLAY_LINE).
  const display = raw.match(/^([1-9]\d*)?(g0|g\^|g\$|gm|gj|gk)$/);
  if (display && DISPLAY_LINE[display[2]]) {
    const spec  = DISPLAY_LINE[display[2]];
    const key   = display[2];
    const count = display[1] ? parseInt(display[1], 10) : 1;
    // Which of these take a count is NOT uniform, and getting it wrong is silent. gj / gk move
    // N screen lines (index.txt:790/:792). g$ takes one too: "the last character of the screen
    // line and [count - 1] screen lines downward" (motion.txt:253-255) -- so a counted g$ is a
    // vertical move FOLLOWED by the line-end jump, which needs two cursorMove calls. g0 / g^ /
    // gm have nothing to repeat, so their count is ignored, matching Vim.
    const down  = count > 1 && (spec.by || key === "g$");
    const args  = spec.by ? { to: spec.to, by: spec.by, value: count } : { to: spec.to };
    const commands = key === "g$" && count > 1
      ? [["cursorMove", { to: "down", by: "wrappedLine", value: count - 1 }]
                , ["cursorMove", { to: spec.to }]]
      : [["cursorMove", args]];
    const note = down
      ? (spec.by
        ? spec.note.replace("one screen line", `${count} screen lines`)
        : `${spec.note.replace(".", "")}, ${count - 1} screen lines down.`)
      : spec.note;
    // the non-wrapped counterpart is the key without its leading "g" -- except gm, whose
    // counterpart is gM (a different command this box already has), not "m".
    const plain = key === "gm" ? "gM" : key.slice(1);
    return { operator: "go", label   : note
            , detail  : `Vim ${key} -- by SCREEN line, so it differs from ${plain} only`
                + " when word wrap is on."
            , target: { kind: "action", action: "ex", origin: "vim", commands } };
  }
  // u -- undo (undo.txt:22). Vim's redo is CTRL-R, which cannot be typed here; use `::redo`.
  // `{count}u` undoes that many changes, like `2g-` already did for the same command (B127).
  const undo = raw.match(/^([1-9]\d*)?u$/);
  if (undo) {
    const count = undo[1] ? parseInt(undo[1], 10) : 1;
    return { operator: "go"
            , label   : count > 1 ? `Undo the last ${count} changes.` : "Undo the last change."
            , detail  : "Vim u (undo.txt:22). Redo is CTRL-R in Vim -- here use ::redo."
            , target  : { kind: "action", action: "ex", commands: Array(count).fill("undo") } };
  }
  const scroll = raw.match(/^([1-9]\d*)?z([tzb.-])$/);
  if (scroll) return scrollCommand(scroll[2], scroll[1] ? parseInt(scroll[1], 10) : 0);
  // z+ / z^ are the two scroll spots that default to a line OUTSIDE the window, so unlike zt / zz
  // they cannot be expressed as "the cursor line" and need the viewport (scroll.txt:59-62, :97-103).
  //   z+  the line just BELOW the window goes to the TOP, cursor at its first non-blank
  //   z^  the line just ABOVE the window goes to the BOTTOM, same cursor rule -- which is exactly
  //       what the existing "-" spot already does, so z^ reuses it rather than growing a branch.
  // `{count}z+` is "just like z<CR>" (:62): line {count} at the top, first non-blank.
  // `{count}z^` is NOT the mirror of that -- :100-103 defines it as a two-step scroll whose result
  // depends on the window HEIGHT, so it is rejected instead of guessed at.
  const scrollEdge = raw.match(/^([1-9]\d*)?z([+^])$/);
  if (scrollEdge) {
    const count = scrollEdge[1] ? parseInt(scrollEdge[1], 10) : 0;
    if (scrollEdge[2] === "+") {
      return scrollCommand("+", count || Math.min(ctx.viewportBottom + 2, ctx.totalLines));
    }
    if (count) return null;                       // counted z^ -- see above
    return scrollCommand("-", Math.max(ctx.viewportTop, 1));
  }
  // z FOLD commands (fold.txt) -- no count (see FOLD_COMMANDS). The key set is derived from the
  // table itself, so adding a fold command there is enough; a hand-kept character class here is
  // what made the B112 batch parse as Invalid despite the table already holding them.
  // A count is accepted only by the foldlevel pair (zm / zr), which carry an `args` field; the
  // rest act on the fold under the cursor and take none, so `3zo` stays Invalid as in Vim.
  // `{count}zF` reads "create a fold for N lines" (index.txt:840). VS Code folds a SELECTION, so
  // the count becomes one: put the cursor at the line start, extend the selection down N - 1
  // lines, then fold. It is the one place a count changes the command LIST rather than an
  // argument, so it is handled before the table dispatch below.
  //
  // Three traps, each settled from the bundle rather than assumed:
  //  - `cursorDownSelect` is registered with `unit: WrappedLine`, so it would count SCREEN rows.
  //    With wrap on, `3zF` would fold the wrong span or nothing. `cursorMove` with `by: "line"`
  //    is the buffer-line form (its own schema lists 'line' and 'wrappedLine' as distinct units).
  //  - `cursorLineStart` comes first to COLLAPSE any selection the editor already had. The box is
  //    a QuickPick, so the editor keeps whatever the user had selected; `expandLineSelection`
  //    would have grown from that selection instead of from the cursor.
  //  - a count of 1 is rejected. `createFoldingRangeFromSelection` guards with
  //    `endLine > startLine` before pushing a range, so a single-line selection folds NOTHING --
  //    the box would have reported a fold it did not create. Vim can fold one line; VS Code
  //    cannot, and saying so beats claiming success.
  //
  // Only `zF` takes a bare count. `zf` is an OPERATOR awaiting a motion (index.txt:861
  // "zf{motion}", fold.txt:321-323), so `3zf` is an incomplete command in Vim, not a synonym.
  const foldLines = raw.match(/^([2-9]\d*|1\d+)(zF)$/);
  if (foldLines) {
    // The selection clamps at the end of the buffer, so near EOF fewer lines fold than were
    // asked for. The parser knows both numbers, so the label reports what will ACTUALLY fold
    // rather than repeating the count back. Below two lines there is nothing VS Code can fold.
    const asked = parseInt(foldLines[1], 10);
    const count = Math.min(asked, ctx.totalLines - ctx.currentLine);
    if (count < 2) {
      return { operator: "go", label   : "Not enough lines below the cursor to fold."
                , detail  : `Vim ${raw} -- VS Code folds a selection, which needs at least 2 lines.`
                , origin  : "vim", target  : { kind: "none" } };
    }
    return { operator: "go"
            , label   : `Create a fold covering ${count} lines from the cursor.`
            , detail  : `Vim ${raw} (index.txt:840) -- selects the lines, then folds the selection.`
            , target  : { kind    : "action", action  : "ex", origin  : "vim"
                , commands: ["cursorLineStart"
                    , ["cursorMove", { to: "down", by: "line", value: count - 1, select: true }]
                    , "editor.createFoldingRangeFromSelection"] } };
  }
  // zh / zl -- horizontal scroll, uncounted (see Z_SCROLL_H for why a count is refused).
  const scrollH = raw.match(/^z([hl])$/);
  if (scrollH) {
    const spec = Z_SCROLL_H[scrollH[1]];
    return { operator: "go", label   : spec.note
            , detail  : `Vim z${scrollH[1]} (scroll.txt) -- only visible with word wrap OFF.`
            , target  : { kind: "action", action: "ex", origin: "vim", commands: [spec.command] } };
  }
  const fold = raw.match(/^([1-9]\d*)?z(.)$/);
  if (fold && FOLD_COMMANDS[fold[2]] && (!fold[1] || FOLD_COMMANDS[fold[2]].args)) {
    const spec  = FOLD_COMMANDS[fold[2]];
    const count = fold[1] ? parseInt(fold[1], 10) : 1;
    const note  = spec.args && count > 1
      ? spec.note.replace("one level", `${count} levels`) : spec.note;
    return { operator: "go", label   : note, detail  : `Vim z${fold[2]} (fold)`
            , target  : { kind    : "action", action  : "ex"
                , commands: [spec.args
                  ? [spec.command, { ...spec.args, levels: count }]
                  : spec.command] } };
  }
  if (/^([1-9]\d*)?z$/.test(raw)) {
    return { operator: "go", label   : "Type the next key after z."
            , detail  : "zz/zt/zb = scroll; zo/zc/za = fold; zR/zM = open/close all folds"
            , origin  : "vim", target  : { kind: "none" } };
  }
  const replace = raw.match(/^([1-9]\d*)?r(.)$/u);
  if (replace) {
    return actionCommand("replaceChar", replace[1] ? parseInt(replace[1], 10) : 1, replace[2]);
  }
  if (/^([1-9]\d*)?r$/.test(raw)) {
    return { operator: "go", label   : "Type the replacement character."
            , detail  : "r{char} replaces the char under the cursor."
            , origin  : "vim", target  : { kind: "none" } };
  }
  return null;
};

module.exports = {
    scrollCommand
  , actionCommand
  , pasteCommand
  , charCodeCommand
  , standaloneCommand
};
