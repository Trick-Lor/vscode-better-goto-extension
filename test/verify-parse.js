"use strict";

/**
 * @file test/verify-parse.js
 * @description Standalone verification of parseCommand (the pure parse core of "Better Go to
 *   Line/Column"). Mocks the 'vscode' module so extension.js loads under plain node with no Extension
 *   Host. Run: node test/verify-parse.js  -- green means the operator + target parsing and the
 *   resolved line/char (for computable targets) match docs/features/. The editor actions
 *   (cursor, selection, delete, yank, bracket preview, the 2-line display) need a manual F5 run.
 *   Includes MODE_CASES for the internal mode gate (default / no-vim), which goto() derives from
 *   the betterGoto.vim setting.
 * @scope src
 * @updated-at 2026-09-02
 */

const Module = require("module");
const assert = require("assert");

// Minimal 'vscode' stub: only what extension.js touches at module load.
const vscodeStub = {
    Position: class {
      constructor(line, character) { this.line = line; this.character = character; }
    }
    // Range has the SAME two-form signature as Selection below, and the apply path uses the numeric
    // one (`new vscode.Range(top, 0, bottom + 1, 0)` in wholeLinesRange, applyWholeLine's case and
    // change branches). A two-arg-only stub stored a raw line NUMBER where a Position belonged and
    // made every wholeLine / linewise apply path look like a silent no-op -- the identical defect
    // already found and fixed for Selection, left in place here because nothing reached it yet.
    , Range: class {
      constructor(a, b, c, d) {
        this.start = typeof a === "number" ? { line: a, character: b } : a;
        this.end   = typeof a === "number" ? { line: c, character: d } : b;
      }
    }
    // real Selection takes EITHER two Positions OR four numbers -- the apply path uses the numeric
    // form, so a two-arg-only stub silently stored a column where a Position belonged
    , Selection: class {
      constructor(a, b, c, d) {
        this.anchor = typeof a === "number" ? { line: a, character: b } : a;
        this.active = typeof a === "number" ? { line: c, character: d } : b;
      }
    }
    , ThemeColor          : class { constructor(id) { this.id = id; } }
    , OverviewRulerLane   : { Full: 7 }
    , TextEditorRevealType: { InCenter: 2 }
    // the clipboard IS the put register (B111), so the apply-path cases drive it through __set
    , env: { clipboard: {
        __text: ""
        , __set(text) { this.__text = text; }
        , readText() { return Promise.resolve(this.__text); }
        , writeText(text) { this.__text = text; return Promise.resolve(); }
    } }
    // B114: record what the apply path actually EXECUTES. The indent / format / case / fold family
    // shipped selecting the right span and running nothing, and no assertion could see it because
    // the parse result was correct. Capturing the command id is the only way to tell "selected the
    // text" from "selected the text AND acted on it".
    , commands: {
        __calls: []
        , __reset() { this.__calls = []; }
        , executeCommand(id, args) {
            this.__calls.push(args === undefined ? id : { id, args });
            return Promise.resolve();
        }
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const { parseCommand, pushHistory, trimHistory, applyPaste, applyCommand }
    = require("../extension.js");

// A fake editor for the APPLY path. Until B111 the suite could only reach parseCommand, so every
// apply-path branch shipped untested -- which is how the put's cursor landing was wrong on two
// paths while 792 parse assertions stayed green. The fake document is LIVE (lineCount reflects
// edits), matching vscode.d.ts:150-157, where lineAt's RESULT is documented as not-live precisely
// because the document itself is; getting that backwards was one of the two bugs.
const fakeEditor = (text, line, character) => {
  const state = { text };
  // offset of a {line, character} in the flat buffer -- shared by getText and the edit builder,
  // so a replace and a read can never disagree about where a position is.
  const offsetOf = (pos) => {
    const lines = state.text.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
    return offset + pos.character;
  };
  const doc = {
        get lineCount() { return state.text.split("\n").length; }
        // `.range` matters: applyWholeLine's change branch deletes `lineAt(line).range`, so a
        // text-only line object made that path throw rather than act.
        , lineAt(n) {
          const line = state.text.split("\n")[n];
          return { text : line
                , range: { start: { line: n, character: 0 }
                    , end  : { line: n, character: line.length } } };
        }
        // B114: the case operators with no built-in command (togglecase / rot13) READ the selected
        // text and write it back, so the fake document needs both halves or that branch cannot be
        // reached at all -- which is how it stayed untested.
        , getText(sel) {
          if (!sel) return state.text;
          const from = offsetOf(sel.anchor || sel.start);
          const to   = offsetOf(sel.active || sel.end);
          return state.text.slice(Math.min(from, to), Math.max(from, to));
        }
    };
  return {
        document : doc
        , selection: { active: { line, character } }
        , state
        // the apply paths all reveal after acting; a no-op stub is enough since scroll position is
        // not something this suite asserts (it is an F5 item), but it must EXIST or every case dies
        , revealRange() {}
        , async edit(callback) {
          const edits = [];
            callback({
                insert : (pos, str) => edits.push({ pos, str })
                , replace: (sel, str) => edits.push({ sel, str })
                // delete is replace-with-nothing; the apply grid reaches it through every
                // delete / change path, which the paste-only harness never did.
                , delete: (rng) => edits.push({ sel: rng, str: "" })
            });
            for (const e of edits) {
              if (e.sel) {
                const from = offsetOf(e.sel.anchor || e.sel.start);
                const to   = offsetOf(e.sel.active || e.sel.end);
                state.text = state.text.slice(0, Math.min(from, to)) + e.str
                        + state.text.slice(Math.max(from, to));
                continue;
              }
              state.text = state.text.slice(0, offsetOf(e.pos)) + e.str
                    + state.text.slice(offsetOf(e.pos));
            }
        }
    };
};
const putTarget = (over) => Object.assign(
    { count: 1, after: true, indent: false, cursorAfter: false }, over);

// 10 lines; blanks at index 3 and 7. Caret at line 5 (index 4), char 3 (index 2). Crafted lines:
// idx 4 = " a cdefg" (^, f/F/t/T, WORD), idx 6 = "{abcdefg" (section), idx 8 = "Hi. Bye."
// (sentence). Every line is length 8 or 0 so the existing length-based cases are unaffected.
const LINES = [
    "abcdefgh"
    , "abcdefgh"
    , "abcdefgh"
    , ""
    , " a cdefg"
    , "abcdefgh"
    , "{abcdefg"
    , ""
    , "Hi. Bye."
    , "abcdefgh"
];
const ctx = {
    totalLines    : 10
    , currentLine   : 4
    , currentChar   : 2
    , lineLength    : (i) => LINES[i].length
    , lineText      : (i) => LINES[i]
    , viewportTop   : 2
    , viewportBottom: 8
};
const PROMPT = "Current Line: 5, Character: 3. Type a line number between 1 and 10 to navigate to.";
// non-empty but unparseable input shows this instead of the empty-state PROMPT
const INVALID = "Invalid input";
// a command we understood but with no target shows a specific message, NOT "Invalid input"
const NF = (ch, dir) => `'${ch}' not found ${dir} the cursor on this line`;

// VERB by operator -- mirrors extension.js, used to auto-build the expected 2-line TOP label.
// A new operator needs a row HERE too, or its position-kind cases fail with "undefined line N..."
// instead of a useful diff (caught this exact way when "fold" was added and missed here first).
const VERB = {
    go        : "Go to", select    : "Select to", selectLine: "Select (line) to", delete    : "Delete to"
    , yank      : "Copy to", change    : "Change to", indent    : "Indent to", outdent   : "Outdent to"
    , format    : "Format to", lowercase : "Lowercase to", uppercase : "Uppercase to"
    , togglecase: "Toggle case to", rot13     : "Rot13 to", fold      : "Fold to"
};

// [ description, value, expect, operator, kind, line|null, character|null, note? ]
// For kind "position": the TOP label is auto-built as `${VERB} line N and charM.` and checked
//   (so `expect` is documentation only, ignored); `note` (8th) checks result.detail when provided.
// For other kinds: `expect` is the exact label checked.
const cases = [
    // built-in goto (parity)
    ["empty -> prompt", "", PROMPT, "go", "none", null, null]
    , ["line", "5", "Go to line 5 and char1.", "go", "position", 4, 1, "Line 5 of the file"]
    , ["line + column", "5:3", "Go to line 5 and char 3.", "go", "position", 4, 2, "Line 5, char 3"]
    , ["':5' -> line 5", ":5", "Go to line 5 and char1.", "go", "position", 4, 1, "Line 5 of the file"]
    , ["out-of-range -> clamps to last line", "99999", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    , ["non-numeric -> invalid", "abc", INVALID, "go", "none", null, null]
    // relative
    , ["relative +2", "+2", "Go to line 7 and char1.", "go", "position", 6, 0, "Down 2 lines (5 + 2)"]
    , ["relative -2", "-2", "Go to line 3 and char1.", "go", "position", 2, 0, "Up 2 lines (5 - 2)"]
    , ["relative chain +2+2", "+2+2", "Go to line 9 and char1.", "go", "position", 8, 0, "Down 4 lines (5 + 4)"]
    , ["relative line+col +2:+3", "+2:+3", "x", "go", "position", 6, 5, "Down 2 lines (5 + 2), right 3 chars (3 + 3)"]
    , ["signed line, abs col -1:1", "-1:1", "x", "go", "position", 3, 0, "Up 1 line (5 - 1), char 1"]
    // percent / gg / G
    , ["percent 50%", "50%", "x", "go", "position", 4, 1, "At 50% of the file (line 5)"]
    , ["percent 100%", "100%", "x", "go", "position", 9, 0, "At 100% of the file (line 10)"]
    , ["percent + rel line 50%+1", "50%+1", "x", "go", "position", 5, 0, "At 50% of the file (line 5), then down 1 line"]
    , ["percent - rel line 50%-2", "50%-2", "x", "go", "position", 2, 0, "At 50% of the file (line 5), then up 2 lines"]
    , ["percent rel chain 50%+1+1", "50%+1+1", "x", "go", "position", 6, 0, "At 50% of the file (line 5), then down 2 lines"]
    , ["percent abs col 50%:3", "50%:3", "x", "go", "position", 4, 2, "At 50% of the file (line 5), char 3"]
    , ["percent rel col 50%:+3", "50%:+3", "x", "go", "position", 4, 5, "At 50% of the file (line 5), right 3 chars (3 + 3)"]
    , ["percent rel col colon 50%:-1", "50%:-1", "x", "go", "position", 4, 1, "At 50% of the file (line 5), left 1 char (3 - 1)"]
    , ["percent abs-chain col 50%:3+2", "50%:3+2", "x", "go", "position", 4, 4, "At 50% of the file (line 5), char 5"]
    , ["percent offset + abs-chain col 50%+1:3+2", "50%+1:3+2", "x", "go", "position", 5, 4, "At 50% of the file (line 5), then down 1 line, char 5"]
    , ["percent rel line + col 20%+1:-2", "20%+1:-2", "x", "go", "position", 2, 0, "At 20% of the file (line 2), then down 1 line, left 2 chars (3 - 2)"]
    , ["B073 percent over 100 is Invalid (Vim beeps) 150%", "150%", INVALID, "go", "none", null, null]
    , ["B077 gM count over 100 -> middle 150gM", "150gM", "At the middle of the line (char 5)", "go", "position", 4, 4, "At the middle of the line (char 5)"]
    , ["percent 0%+1", "0%+1", "x", "go", "position", 1, 0, "At 0% of the file (line 1), then down 1 line"]
    , ["percent garbage 50%abc -> invalid", "50%abc", INVALID, "go", "none", null, null]
    , ["delete to percent col d50%:3", "d50%:3", "x", "delete", "position", 4, 2, "At 50% of the file (line 5), char 3"]
    // relative-percent: +N% / -N% = current line +/- N% of the file, composing with chain + column
    , ["relative percent +20%", "+20%", "x", "go", "position", 6, 0, "Down 20% of the file (5 + 2)"]
    , ["relative percent -20%", "-20%", "x", "go", "position", 2, 0, "Up 20% of the file (5 - 2)"]
    , ["relative percent chain +20%+1", "+20%+1", "x", "go", "position", 7, 0, "Down 20% of the file (5 + 2), then down 1 line"]
    // a percent line-offset chain shows as its own clause, before any column clause
    , ["percent offset + abs col 50%+1:3", "50%+1:3", "x", "go", "position", 5, 2, "At 50% of the file (line 5), then down 1 line, char 3"]
    , ["percent offset singular +50%-1", "+50%-1", "x", "go", "position", 8, 0, "Down 50% of the file (5 + 5), then up 1 line"]
    , ["relative percent + col +20%:-2", "+20%:-2", "x", "go", "position", 6, 0, "Down 20% of the file (5 + 2), left 2 chars (3 - 2)"]
    , ["relative percent +50% clamps", "+50%", "x", "go", "position", 9, 0, "Down 50% of the file (5 + 5)"]
    // N+M% / N-M% -- absolute line + a single percent OFFSET in lines (distinct from N%+M)
    , ["line + pct offset 5+10%", "5+10%", "x", "go", "position", 5, 0, "Line 5, then down 10% of the file (1 line)"]
    , ["line - pct offset 5-10%", "5-10%", "x", "go", "position", 3, 0, "Line 5, then up 10% of the file (1 line)"]
    , ["line + pct offset 2+50%", "2+50%", "x", "go", "position", 6, 0, "Line 2, then down 50% of the file (5 lines)"]
    , ["line + pct + abs col 5+10%:3", "5+10%:3", "x", "go", "position", 5, 2, "Line 5, then down 10% of the file (1 line), char 3"]
    , ["rel base + pct offset +5+10%", "+5+10%", "x", "go", "position", 9, 0, "Down 5 lines (5 + 5), then down 10% of the file (1 line)"]
    , ["rel base + pct offset -2+50%", "-2+50%", "x", "go", "position", 7, 0, "Up 2 lines (5 - 2), then down 50% of the file (5 lines)"]
    , ["line + pct + further chain 2+50%+1", "2+50%+1", "x", "go", "position", 7, 0, "Line 2, then down 50% of the file (5 lines), then down 1 line"]
    , ["line + pct + abs-chain col 2+50%:3+2", "2+50%:3+2", "x", "go", "position", 6, 4, "Line 2, then down 50% of the file (5 lines), char 5"]
    // B014 -- the base before a percent offset may be a CHAIN (abs or relative), equal to its summed
    // single-base form: 2+2+50% == 4+50%, +5+5+10% == +10+10%. A chain base was Invalid before.
    , ["B014 abs-chain base + pct 2+2+50%", "2+2+50%", "x", "go", "position", 8, 0, "Line 4, then down 50% of the file (5 lines)"]
    , ["B014 rel-chain base + pct +1+1+10%", "+1+1+10%", "x", "go", "position", 7, 0, "Down 2 lines (5 + 2), then down 10% of the file (1 line)"]
    , ["B014 mixed-sign chain base 6-2+50%", "6-2+50%", "x", "go", "position", 8, 0, "Line 4, then down 50% of the file (5 lines)"]
    , ["B014 rel-chain base == single +5+5+10%", "+5+5+10%", "x", "go", "position", 9, 0, "Down 10 lines (5 + 10), then down 10% of the file (1 line)"]
    , ["gg", "gg", "x", "go", "position", 0, 0, "First line of the file"]
    , ["G", "G", "x", "go", "position", 9, 0, "Last line of the file"]
    // B052: gg/G take a {count} = go to that line (Vim [count]gg / [count]G); the fixture lines are
    // unindented so first-non-blank is char 0 here (indented first-non-blank checked in CUSTOM_CTX).
    , ["B052 count 2gg -> line 2", "2gg", "x", "go", "position", 1, 0, "Line 2, first non-blank"]
    , ["B052 count 3G -> line 3", "3G", "x", "go", "position", 2, 0, "Line 3, first non-blank"]
    , ["B052 count 1gg -> line 1", "1gg", "x", "go", "position", 0, 0, "Line 1, first non-blank"]
    , ["B052 count clamps 100G -> last", "100G", "x", "go", "position", 9, 0, "Line 10, first non-blank"]
    , ["B052 count gg cannot take a column 2gg:", "2gg:", INVALID, "go", "none", null, null]
    // line ends, paragraph, viewport
    , ["$ end of line", "$", "x", "go", "position", 4, 7, "At the end of the line"]
    , ["B053 count 2$ end of next line", "2$", "x", "go", "position", 5, 7, "End of line, 1 down"]
    , ["B053 count $ clamps 100$", "100$", "x", "go", "position", 9, 7, "End of line, 99 down"]
    , ["B053 $$ -> invalid", "$$", INVALID, "go", "none", null, null]
    , ["0 start of line", "0", "x", "go", "position", 4, 0, "At the first character of the line"]
    , ["{ previous blank", "{", "x", "go", "position", 3, 0, "Backward 1 paragraph"]
    , ["} next blank", "}", "x", "go", "position", 7, 0, "Forward 1 paragraph"]
    , ["H top of screen", "H", "x", "go", "position", 2, 0, "Top line of the window"]
    , ["M middle of screen", "M", "x", "go", "position", 5, 0, "Middle line of the window"]
    , ["L bottom of screen", "L", "x", "go", "position", 8, 0, "Bottom line of the window"]
    , ["B053 count 2H from top", "2H", "x", "go", "position", 3, 0, "Line 2 from the window top, first non-blank"]
    , ["B053 count 2L from bottom", "2L", "x", "go", "position", 7, 0, "Line 2 from the window bottom, first non-blank"]
    , ["B053 count clamps 100H to window bottom", "100H", "x", "go", "position", 8, 0, "Line 100 from the window top, first non-blank"]
    , ["B053 M takes no count 2M -> invalid", "2M", INVALID, "go", "none", null, null]
    // word motions self-compute a coordinate (kind position)
    , ["word w", "w", "x", "go", "position", 4, 3, "Forward 1 word"]
    , ["word 2w", "2w", "x", "go", "position", 5, 0, "Forward 2 words"]
    , ["word b", "b", "x", "go", "position", 4, 1, "Backward 1 word"]
    , ["word e", "e", "x", "go", "position", 4, 7, "Forward to the end of the word"]
    // bracket
    , ["bracket", "%", "Go to the matching bracket.", "go", "bracket", null, null]
    // operators. B099 re-added v / V: they render Vim's `v{motion}` / `V{motion}` SEQUENCE -- the
    // observable result is a charwise / linewise selection from the cursor to the target, which the
    // box reproduces (it just cannot STAY in Visual mode, the same degrade `c` has for Insert mode).
    , ["B099 v selects to a motion", "vw", "x", "select", "position", 4, 3, "Forward 1 word"]
    , ["B099 v selects to a line", "v5", "x", "select", "position", 4, 1, "Line 5 of the file"]
    , ["B099 v to end of line", "v$", "x", "select", "position", 4, 7, "At the end of the line"]
    , ["B099 V selects whole lines", "V5", "x", "selectLine", "position", 4, 1, "Line 5 of the file"]
    , ["B099 bare v guides", "v", "Type a target to select.", "select", "none", null, null]
    , ["B099 bare V guides", "V", "Type a target to select whole lines.", "selectLine", "none", null, null]
    , ["B099 v% selects to the bracket", "v%", "Select to the matching bracket.", "select", "bracket", null, null]
    , ["B099 V% selects the line span", "V%", "Select (line) to the matching bracket.", "selectLine", "bracket", null, null]
    , ["B099 v + range", "v5;9", "Select line 5 and char 1 to line 9 and char 1.", "select", "range", null, null, "From line 5 char 1 to line 9 char 1"]
    , ["B099 V + range reads the line span", "V5;9", "Select lines 5 to 9.", "selectLine", "range", null, null, "From line 5 to line 9"]
    // B100 ga -- the char code under the cursor (various.txt:53). Message only; Enter does nothing.
    // the shared fixture's cursor (line 5 idx 4, char 3 idx 2) sits on a SPACE in " a cdefg"
    , ["B100 ga shows the char code", "ga", "< >  32,  Hex 20,  Octal 40", "go", "none", null, null]
    , ["delete to line", "d5", "x", "delete", "position", 4, 1, "Line 5 of the file"]
    , ["yank to line", "y5", "x", "yank", "position", 4, 1, "Line 5 of the file"]
    , ["delete to bracket", "d%", "Delete to the matching bracket.", "delete", "bracket", null, null]
    , ["delete to word", "dw", "x", "delete", "position", 4, 3, "Forward 1 word"]
    , ["delete 2 words", "d2w", "x", "delete", "position", 5, 0, "Forward 2 words"]
    , ["yank to word", "yw", "x", "yank", "position", 4, 3, "Forward 1 word"]
    , ["delete to viewport top", "dH", "x", "delete", "position", 2, 0, "Top line of the window"]
    , ["delete to end of line", "d$", "x", "delete", "position", 4, 7, "At the end of the line"]
    , ["bare operator -> target guide", "d", "Type a target to delete.", "delete", "none", null, null]
    , ["g prefix -> g-motion guide", "g", "Type the next key after g.", "go", "none", null, null]
    // B085 self-contained one-shot commands (no target): x/X/J/~/r{char} + uppercase D/C/Y aliases
    , ["x delete char under", "x", "Delete the character under the cursor.", "go", "action", null, null]
    , ["X delete char before", "X", "Delete the character before the cursor.", "go", "action", null, null]
    , ["J join lines", "J", "Join this line with the line below.", "go", "action", null, null]
    , ["~ toggle case char", "~", "Toggle the case of the character under the cursor.", "go", "action", null, null]
    , ["r{char} replace char", "rz", "Replace the character under the cursor with 'z'.", "go", "action", null, null]
    , ["bare r pends for the char", "r", "Type the replacement character.", "go", "none", null, null]
    , ["D == d$ delete to EOL", "D", "x", "delete", "position", 4, 7, "At the end of the line"]
    , ["C == c$ change to EOL", "C", "x", "change", "position", 4, 7, "At the end of the line"]
    , ["Y == yy yank whole line", "Y", "Copy the current line.", "yank", "wholeLine", null, null]
    // B085 counts (x/X/J/r take a [count]; gJ = join no space); ~ takes a count too since B094
    , ["3x delete 3 chars", "3x", "Delete 3 characters under the cursor.", "go", "action", null, null]
    , ["2X delete 2 chars before", "2X", "Delete 2 characters before the cursor.", "go", "action", null, null]
    , ["3J join 3 lines", "3J", "Join 3 lines.", "go", "action", null, null]
    // B111 PUT: p / P / gp / gP and the indent-adjusting bracket forms (change.txt:1109-1178).
    // The box keeps no named registers, so a put always reads the clipboard that y / d / yy wrote.
    , ["B111 p puts after", "p", "Put the clipboard after the cursor.", "go", "action", null, null]
    , ["B111 P puts before", "P", "Put the clipboard before the cursor.", "go", "action", null, null]
    , ["B111 3p carries the count", "3p", "Put the clipboard after the cursor 3 times."
        , "go", "action", null, null]
    , ["B111 gp leaves the cursor past the text", "gp"
        , "Put the clipboard after the cursor, cursor after the new text.", "go", "action", null, null]
    , ["B111 gP is before + cursor past", "gP"
        , "Put the clipboard before the cursor, cursor after the new text.", "go", "action", null, null]
    // of the four bracket forms only "]p" puts AFTER -- [p, [P and ]P all put BEFORE (:1168-1178)
    , ["B111 ]p is the only bracket form that puts after", "]p"
        , "Put the clipboard after the cursor, indent matched to this line.", "go", "action", null, null]
    , ["B111 [p puts before with indent", "[p"
        , "Put the clipboard before the cursor, indent matched to this line.", "go", "action", null, null]
    , ["B111 ]P puts before with indent", "]P"
        , "Put the clipboard before the cursor, indent matched to this line.", "go", "action", null, null]
    , ["B111 [P puts before with indent", "[P"
        , "Put the clipboard before the cursor, indent matched to this line.", "go", "action", null, null]
    // B112 -- one-shots that delegate to a VS Code command. Each cites its index.txt row.
    , ["B112 ZZ saves and closes", "ZZ", "Save the file and close the editor.", "go", "action", null, null]
    , ["B112 ZQ closes without saving", "ZQ", "Close the editor without saving.", "go", "action", null, null]
    , ["B112 gt next editor", "gt", "Go to the next editor.", "go", "action", null, null]
    , ["B112 gT previous editor", "gT", "Go to the previous editor.", "go", "action", null, null]
    , ["B112 K shows the hover", "K", "Show the hover for the word under the cursor."
        , "go", "action", null, null]
    , ["B112 go jumps to a byte offset", "go", "Go to a byte offset in the file."
        , "go", "action", null, null]
    , ["B112 gf names what openLink really does", "gf"
        , "Open the link under the cursor (a URL, or a path the language marks as a link)."
        , "go", "action", null, null]
    , ["B112 gF cannot add the line-number jump", "gF"
        , "Open the link under the cursor (VS Code does not add Vim's line-number jump)."
        , "go", "action", null, null]
    // B112 display-line motions: by SCREEN line, so they delegate to cursorMove -- only the editor
    // knows where its wrap points are. With wrap OFF they equal 0/^/$/j/k, which is the trap.
    , ["B112 g0 screen-line start", "g0", "Go to the start of the screen line.", "go", "action", null, null]
    , ["B112 g^ screen-line first non-blank", "g^"
        , "Go to the first non-blank of the screen line.", "go", "action", null, null]
    , ["B112 g$ screen-line end", "g$", "Go to the end of the screen line.", "go", "action", null, null]
    , ["B112 gm screen-line middle", "gm", "Go to the middle of the screen line.", "go", "action", null, null]
    , ["B112 gj down one screen line", "gj", "Go down one screen line.", "go", "action", null, null]
    , ["B112 gk up one screen line", "gk", "Go up one screen line.", "go", "action", null, null]
    // count applies to the by-line pair only -- there is nothing to repeat about "go to the start"
    , ["B112 3gj carries the count", "3gj", "Go down 3 screen lines.", "go", "action", null, null]
    , ["B112 2g0 ignores the count", "2g0", "Go to the start of the screen line.", "go", "action", null, null]
    // the delegates must not shadow the g-motions that share their first letter
    , ["B112 gg still reaches line 1", "gg", "x", "go", "position", 0, 0, "First line of the file"]
    , ["B112 ge is still the word-end motion", "ge", "x", "go", "position", 4, 1, "Backward to the end of a word"]
    , ["B112 gM is still the % across the line", "gM", "x", "go", "position", 4, 4
        , "At the middle of the line (char 5)"]
    // B112 the rest of the fold family. The accepted key set is now derived from FOLD_COMMANDS
    // itself -- a hand-kept character class had held these back even after the table listed them.
    , ["B112 zA toggles recursively", "zA", "Toggle the fold under the cursor, recursively."
        , "go", "action", null, null]
    , ["B112 zD removes manual folds", "zD", "Remove the manually created folds under the cursor."
        , "go", "action", null, null]
    , ["B112 zF creates a fold", "zF", "Create a fold from the current selection.", "go", "action", null, null]
    , ["B112 zd removes one manual fold", "zd", "Remove the manually created fold under the cursor."
        , "go", "action", null, null]
    , ["B112 zf creates a fold", "zf", "Create a fold from the current selection.", "go", "action", null, null]
    , ["B112 zn opens every fold", "zn", "Open every fold (Vim turns folding off).", "go", "action", null, null]
    , ["B112 zN closes every fold", "zN", "Close every fold (Vim turns folding back on)."
        , "go", "action", null, null]
    , ["B112 zi opens every fold", "zi", "Open every fold (Vim toggles folding).", "go", "action", null, null]
    , ["B112 zX closes every fold", "zX", "Close every fold (Vim re-applies 'foldlevel')."
        , "go", "action", null, null]
    , ["B112 zm folds one level", "zm", "Fold one level.", "go", "action", null, null]
    , ["B112 3zm folds 3 levels", "3zm", "Fold 3 levels.", "go", "action", null, null]
    , ["B112 2zr unfolds 2 levels", "2zr", "Unfold 2 levels.", "go", "action", null, null]
    , ["B112 3zo is Invalid -- only zm/zr take a count", "3zo", INVALID, "go", "none", null, null]
    , ["B112 zr unfolds one level", "zr", "Unfold one level.", "go", "action", null, null]
    // the widened key gate must NOT start accepting a z key that has no table entry
    , ["B112 zq is still Invalid", "zq", INVALID, "go", "none", null, null]
    , ["B112 zt is still the scroll, not a fold", "zt"
        , "Scroll: the current line to the top of the window.", "go", "action", null, null]
    // B112 insert-ENTRY commands. Vim describes these as "start insert", but VS Code has no Normal
    // mode to leave, so only the cursor move / line open is left to do. I and A are therefore
    // POSITIONS (they preview); o / O change the buffer so they stay actions.
    , ["B112 I lands on the first non-blank", "I", "x", "go", "position", 4, 1
        , "At the first non-blank character, ready to type"]
    , ["B112 A lands past the last char", "A", "x", "go", "position", 4, 8
        , "At the end of the line, ready to type"]
    , ["B112 o opens a line below", "o", "Open a new line below and put the cursor there."
        , "go", "action", null, null]
    , ["B112 O opens a line above", "O", "Open a new line above and put the cursor there."
        , "go", "action", null, null]
    // index.txt states both outright: S is a synonym for cc (:363-364), s == c{count}l (:425-426).
    // They are REWRITTEN to those forms, so they inherit the tested c-operator paths.
    , ["B112 S is cc", "S", "Change the current line.", "change", "wholeLine", null, null]
    , ["B112 s is cl", "s", "x", "change", "position", 4, 3, "Right 1 char (3 + 1)"]
    , ["B112 3s is c3l", "3s", "x", "change", "position", 4, 5, "Right 3 chars (3 + 3)"]
    // B112 find-match / change navigation. gn / gN read the FIND widget's term, not this box's
    // remembered pattern -- a documented divergence, but the closest live behavior VS Code has.
    , ["B112 gn selects the next match", "gn", "Select the next match of the current find."
        , "go", "action", null, null]
    , ["B112 gN selects the previous match", "gN", "Select the previous match of the current find."
        , "go", "action", null, null]
    , ["B112 gv expands the selection", "gv"
        , "Expand the selection (Vim reselects the last visual area).", "go", "action", null, null]
    , ["B112 [c previous change", "[c", "Go to the previous change.", "go", "action", null, null]
    , ["B112 ]c next change", "]c", "Go to the next change.", "go", "action", null, null]
    // index.txt:664 / :704 state [f and ]f as exact synonyms of gf
    , ["B112 [f is gf", "[f"
        , "Open the link under the cursor (a URL, or a path the language marks as a link)."
        , "go", "action", null, null]
    , ["B112 ]f is gf", "]f"
        , "Open the link under the cursor (a URL, or a path the language marks as a link)."
        , "go", "action", null, null]
    // B112 review: a count is accepted ONLY where index.txt marks one. [c ]c gn gN carry the count
    // column (:659 :700 :796 :758); gt gT ZZ ZQ K gf gF do not, so a count there stays Invalid
    // instead of silently behaving as the uncounted form.
    , ["B112 3[c repeats the change jump", "3[c", "Go to the previous change, 3 times."
        , "go", "action", null, null]
    , ["B112 2gn repeats the match selection", "2gn"
        , "Select the next match of the current find, 2 times.", "go", "action", null, null]
    // tabpage.txt:210 -- {count}gt is ABSOLUTE ("go to tab page {count}"), so 3gt must open the
    // THIRD editor, never the third-next one. :222 makes {count}gT relative, so the two differ.
    , ["B112 3gt goes to editor 3", "3gt", "Go to editor 3 in the tab bar.", "go", "action", null, null]
    , ["B112 1gt goes to editor 1", "1gt", "Go to editor 1 in the tab bar.", "go", "action", null, null]
    , ["B112 3gT repeats backwards", "3gT", "Go to the previous editor, 3 times.", "go", "action", null, null]
    // index.txt:414,355 -- o / O state "repeat N times". Vim repeats the typed text; with no typed
    // text that reduces to N new lines.
    , ["B112 3o opens 3 lines", "3o", "Open a new line below and put the cursor there, 3 times.", "go", "action", null, null]
    , ["B112 3O opens 3 lines above", "3O", "Open a new line above and put the cursor there, 3 times.", "go", "action", null, null]
    // index.txt:840 -- {count}zF folds N lines. Regression: the counted forms must not swallow the
    // uncounted zF, and no OTHER z command may start accepting a count off the back of this branch.
    , ["B112 3zF folds 3 lines", "3zF", "Create a fold covering 3 lines from the cursor.", "go", "action", null, null]
    // The fixture is 10 lines with the cursor on line 5, so at most 6 lines can fold. A two-digit
    // count must parse AND clamp -- the label reports what will really fold, not what was asked.
    , ["B112 12zF clamps to the 6 lines left", "12zF", "Create a fold covering 6 lines from the cursor.", "go", "action", null, null]
    , ["B112 6zF folds exactly to EOF", "6zF", "Create a fold covering 6 lines from the cursor.", "go", "action", null, null]
    // VS Code's createFoldingRangeFromSelection guards with endLine > startLine, so a one-line
    // selection folds NOTHING. Claiming a fold we did not create is worse than rejecting.
    , ["B112 1zF Invalid -- VS Code cannot fold one line", "1zF", INVALID, "go", "none", null, null]
    // zf is an OPERATOR awaiting a motion (index.txt:861 "zf{motion}"), not a synonym for zF.
    // Superseded by B114: at B112 zf was rejected outright as "an operator awaiting a motion, not
    // implemented as such". It is now implemented as such (fold.txt:322-323), so a count with no
    // motion yet correctly PENDS -- same as bare `d` / `gu` / `>` -- rather than flashing Invalid.
    , ["B114 3zf pends for a motion (superseded)", "3zf", "Type a target to fold.", "fold", "none", null, null]
    , ["B114 1zf pends for a motion (superseded)", "1zf", "Type a target to fold.", "fold", "none", null, null]
    , ["B112 zF still folds the selection", "zF", "Create a fold from the current selection.", "go", "action", null, null]
    // --- B113: the remaining buildable commands -------------------------------------------------
    // `;` repeats the last f/F/t/T in the SAME direction (index.txt:413). It takes no count here
    // because `N;` is better-goto's range half -- see REGEX_FIND_REPEAT. `2;` must therefore
    // stay range-pending, and `f;` must still read ";" as a search CHAR.
    , ["B113 gI goes to column 1", "gI", "Go to line 5 and char 1.", "go", "position", 4, 0]
    // Review: `2gq` rewrote to `=2`, and `=2` is a valid command here ("format to line 2"), so a
    // counted operator with no motion yet RESOLVED instead of pending. It must behave like `2=`.
    , ["B113 2gq pends like 2=", "2gq", "Type a target to format.", "format", "none", null, null]
    , ["B113 3gw pends like 3=", "3gw", "Type a target to format.", "format", "none", null, null]
    , ["B113 2= pends (reference)", "2=", "Type a target to format.", "format", "none", null, null]
    // Review: the insert-entry family accepted a count and threw it away. Vim's N repeats the TYPED
    // text; this box types nothing, so N has nothing to do and every N lands identically. Rejected,
    // the same call made for `2zh` / `{count}z^` / `5go`. `o` / `O` keep their count -- N new lines
    // is something a count can actually mean here.
    , ["B113 2a Invalid -- nothing for the count to repeat", "2a", INVALID, "go", "none", null, null]
    , ["B113 3i Invalid -- nothing for the count to repeat", "3i", INVALID, "go", "none", null, null]
    , ["B113 2gI Invalid -- nothing for the count to repeat", "2gI", INVALID, "go", "none", null, null]
    , ["B113 2I Invalid -- same rule as a / i", "2I", INVALID, "go", "none", null, null]
    , ["B113 2A Invalid -- same rule as a / i", "2A", INVALID, "go", "none", null, null]
    , ["B113 3o still counts -- N lines is observable", "3o", "Open a new line below and put the cursor there, 3 times.", "go", "action", null, null]
    // gq / gw format the motion's text; both collapse onto the `=` operator (one VS Code primitive).
    , ["B113 gqj formats down a line", "gqj", "Format to line 6 and char 3.", "format", "position", 5, 2]
    , ["B113 gwj formats down a line", "gwj", "Format to line 6 and char 3.", "format", "position", 5, 2]
    , ["B113 gqq formats the line", "gqq", "Format the current line.", "format", "wholeLine", null, null]
    , ["B113 gqgq is the same as gqq", "gqgq", "Format the current line.", "format", "wholeLine", null, null]
    , ["B113 gww formats the line", "gww", "Format the current line.", "format", "wholeLine", null, null]
    , ["B113 2gqj carries the count", "2gqj", "Format to line 7 and char 3.", "format", "position", 6, 2]
    // regressions: every other g command must be untouched by the gq/gw rewrite
    , ["B113 gg still goes to line 1", "gg", "Go to line 1 and char 1.", "go", "position", 0, 0]
    , ["B113 gJ still joins", "gJ", "Join this line with the line below (no space).", "go", "action", null, null]
    // g- / g+ walk the undo history; VS Code's is linear, so they are undo / redo.
    , ["B113 g- undoes", "g-", "Go to an older state of the file (undo).", "go", "action", null, null]
    , ["B113 g+ redoes", "g+", "Go to a newer state of the file (redo).", "go", "action", null, null]
    , ["B113 3g- repeats", "3g-", "Go to an older state of the file (undo), 3 times.", "go", "action", null, null]
    // zh / zl scroll horizontally. No count: VS Code's step is a hard-coded 2 columns, so a count
    // would be off by 2x. zH / zL / ze / zs have no VS Code primitive at all.
    , ["B113 zh scrolls left", "zh", "Scroll the view left (VS Code's step is 2 columns).", "go", "action", null, null]
    , ["B113 zl scrolls right", "zl", "Scroll the view right (VS Code's step is 2 columns).", "go", "action", null, null]
    , ["B113 2zh Invalid -- no count on horizontal scroll", "2zh", INVALID, "go", "none", null, null]
    , ["B113 zH Invalid -- no half-screenwidth primitive", "zH", INVALID, "go", "none", null, null]
    , ["B113 ze Invalid -- no horizontal reveal primitive", "ze", INVALID, "go", "none", null, null]
    // regressions: the scroll and fold z commands must be untouched by the zh/zl branch
    // z+ / z^ default to a line OUTSIDE the window, so they read the viewport (scroll.txt:59, :97).
    // Fixture viewport is lines 0-9 of a 10-line file, so z+ clamps to the last line and z^ to 1.
    , ["B113 z+ takes the line below the window to the top", "z+", "Scroll: line 10 to the top of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B113 z^ takes the line above the window to the bottom", "z^", "Scroll: line 2 to the bottom of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B113 3z+ is z<CR> on line 3", "3z+", "Scroll: line 3 to the top of the window, cursor to its first non-blank.", "go", "action", null, null]
    // counted z^ is a two-step scroll whose result depends on the window height (scroll.txt:100-103)
    , ["B113 3z^ Invalid -- not the mirror of 3z+", "3z^", INVALID, "go", "none", null, null]
    // B113: the indent / format / case operators were refusing a RANGE target, so every text object
    // was accepted by d/y/c/v/V and rejected by =/>/</gu/gU/g~/g?. `guaw` and `gqip` are everyday
    // Vim. One omission in RANGE_VERB, and selectToTarget had no range case to select with.
    , ["B113 =aw formats a word object", "=aw", "Format line 5 and char 3 to line 5 and char 8.", "format", "range", null, null]
    , ["B113 >aw indents a word object", ">aw", "Indent line 5 and char 3 to line 5 and char 8.", "indent", "range", null, null]
    , ["B113 guaw lowercases a word object", "guaw", "Lowercase line 5 and char 3 to line 5 and char 8.", "lowercase", "range", null, null]
    , ["B113 gUiw uppercases an inner word", "gUiw", "Uppercase line 5 and char 3 to line 5 and char 3.", "uppercase", "range", null, null]
    , ["B113 g~aw toggles case of a word object", "g~aw", "Toggle case of line 5 and char 3 to line 5 and char 8.", "togglecase", "range", null, null]
    , ["B113 gqiw formats an inner word", "gqiw", "Format line 5 and char 3 to line 5 and char 3.", "format", "range", null, null]
    , ["B113 gqap formats a paragraph object", "gqap", "Format line 5 and char 1 to line 8 and char 1.", "format", "range", null, null]
    , ["B113 =5:5;5:9 formats a two-coordinate range", "=5:5;5:9", "Format line 5 and char 5 to line 5 and char 9.", "format", "range", null, null]
    // regressions: the operators that already took objects must be unchanged
    , ["B113 daw unchanged", "daw", "Delete line 5 and char 3 to line 5 and char 8.", "delete", "range", null, null]
    , ["B113 vaw unchanged", "vaw", "Select line 5 and char 3 to line 5 and char 8.", "select", "range", null, null]
    , ["B113 guj still a motion target", "guj", "Lowercase to line 6 and char 1.", "lowercase", "position", 5, 2]
    , ["B113 guu still whole-line", "guu", "Lowercase the current line.", "lowercase", "wholeLine", null, null]
    // --- B114: zf{motion} -- fold.txt:322-323, "Operator to create a fold" -----------------------
    // The bare zf/zF selection-fold from B112/B113 is a DIFFERENT thing (no motion, just the
    // current selection); this is the real operator, reusing the same motion/text-object machinery
    // every other operator shares, and the same select-then-run-one-command apply path as = / >.
    , ["B114 zfj folds a motion", "zfj", "Fold to line 6 and char 3.", "fold", "position", 5, 2]
    // These three used to assert a fold. They were WRONG: every one of them resolves inside a
    // single line, and `createFoldingRangeFromSelection` guards with `endLine > startLine`, so the
    // box reported a fold it never created -- the same defect B113 caught for `1zF`. The tests had
    // encoded the bug, which is why the bundle had to be re-read rather than trusted to the suite.
    , ["B114 zfw rejects a same-line span", "zfw", "That covers one line -- VS Code cannot fold a single line.", "go", "none", null, null]
    , ["B114 zfaw rejects a same-line object", "zfaw", "That covers one line -- VS Code cannot fold a single line.", "go", "none", null, null]
    , ["B114 zfip folds a paragraph object", "zfip", "Fold line 5 and char 1 to line 7 and char 8.", "fold", "range", null, null]
    , ["B114 zf5:5;5:9 rejects a same-line range", "zf5:5;5:9", "That covers one line -- VS Code cannot fold a single line.", "go", "none", null, null]
    // count multiplies into the motion's own count either side of "zf" (motion.txt:63-65)
    , ["B114 zf2w matches 2w's count", "zf2w", "Fold to line 6 and char 1.", "fold", "position", 5, 0]
    , ["B114 2zfw matches zf2w", "2zfw", "Fold to line 6 and char 1.", "fold", "position", 5, 0]
    // a count with no motion yet pends, exactly like bare d / gu / > -- not Invalid, not a no-op
    , ["B114 2zf pends for a motion", "2zf", "Type a target to fold.", "fold", "none", null, null]
    // the guard must not over-reject: any span of 2+ lines still folds, in both directions
    , ["B114 zfk folds upward", "zfk", "Fold to line 4 and char 1.", "fold", "position", 3, 0]
    , ["B114 zfG folds to the last line", "zfG", "Fold to line 10 and char 1.", "fold", "position", 9, 0]
    , ["B114 zfgg folds to the first line", "zfgg", "Fold to line 1 and char 1.", "fold", "position", 0, 0]
    // and the guard is fold-only: every other operator still accepts a same-line span
    , ["B114 same-line span still fine for =", "=aw", "Format line 5 and char 3 to line 5 and char 8.", "format", "range", null, null]
    , ["B114 same-line span still fine for d", "daw", "Delete line 5 and char 3 to line 5 and char 8.", "delete", "range", null, null]
    // regressions: the bare selection-fold and every prefix-sharing z/g command stay untouched
    , ["B114 bare zf still folds the selection", "zf", "Create a fold from the current selection.", "go", "action", null, null]
    , ["B114 bare zF still folds the selection", "zF", "Create a fold from the current selection.", "go", "action", null, null]
    , ["B114 zj still a fold-navigation delegate", "zj", "Move down to the start of the next fold.", "go", "action", null, null]
    , ["B114 zk still a fold-navigation delegate", "zk", "Move up to the end of the previous fold.", "go", "action", null, null]
    , ["B114 gf still opens a link, untouched by zf", "gf", "Open the link under the cursor (a URL, or a path the language marks as a link).", "go", "action", null, null]
    , ["B113 zt still scrolls to top", "zt", "Scroll: the current line to the top of the window.", "go", "action", null, null]
    , ["B113 z- still scrolls to bottom", "z-", "Scroll: the current line to the bottom of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B113 5zt still counts", "5zt", "Scroll: line 5 to the top of the window.", "go", "action", null, null]
    , ["B113 zo still opens the fold", "zo", "Open the fold under the cursor.", "go", "action", null, null]
    , ["B112 3zo still Invalid -- zo takes no count", "3zo", INVALID, "go", "none", null, null]
    , ["B112 3za still Invalid -- za takes no count", "3za", INVALID, "go", "none", null, null]
    , ["B112 2ZZ is Invalid -- ZZ takes no count", "2ZZ", INVALID, "go", "none", null, null]
    // B112 ex second pass. Triaging all 566 missing ex commands left only :isplit and :set with a
    // concrete VS Code mechanism; the rest were scripting, argument-taking, list-printing, Vim-only
    // options, or already implemented under another spelling. The alias rows below are those other
    // spellings -- index.txt lists each as its own command, so rejecting them was a real gap.
    , ["B112 :isplit opens the definition aside", ":isplit"
        , "Open the definition under the cursor beside this editor.", "go", "action", null, null]
    , ["B112 :set opens Settings", ":set", "Open Settings.", "go", "action", null, null]
    , ["B112 :bN is :bp", ":bN", "Go to the previous editor.", "go", "action", null, null]
    , ["B112 :bNext is :bp", ":bNext", "Go to the previous editor.", "go", "action", null, null]
    , ["B112 :brewind is :bf", ":brewind", "Go to the first editor.", "go", "action", null, null]
    , ["B112 :bunload is :bd", ":bunload", "Close the editor.", "go", "action", null, null]
    , ["B112 :bwipeout is :bd", ":bwipeout", "Close the editor.", "go", "action", null, null]
    , ["B112 :earlier is undo", ":earlier", "Undo the last change.", "go", "action", null, null]
    , ["B112 :later is redo", ":later", "Redo the undone change.", "go", "action", null, null]
    // an alias must point DIRECTLY at an EX_ACTIONS key -- the lookup is one level, so a chain
    // (bunload -> bun -> bd) would resolve to nothing. These two prove the chain was flattened.
    , ["B112 :bun resolves (not a chained alias)", ":bun", "Close the editor.", "go", "action", null, null]
    , ["B112 :bw resolves (not a chained alias)", ":bw", "Close the editor.", "go", "action", null, null]
    // g$ DOES take a count: "the last character of the screen line and [count-1] screen lines
    // downward" (motion.txt:253-255) -- a comment here previously claimed Vim ignores it.
    , ["B112 5g$ moves down first", "5g$", "Go to the end of the screen line, 4 screen lines down."
        , "go", "action", null, null]
    , ["B112 2g0 still ignores its count", "2g0", "Go to the start of the screen line."
        , "go", "action", null, null]
    // the bracket delegates must not shadow the unmatched-bracket / section motions. The shared
    // fixture has no "(", so [( correctly REPORTS that -- which still proves it reached the bracket
    // motion rather than being swallowed by the new [c / [f delegates.
    , ["B112 [( is still the bracket motion", "[(", "No unmatched '(' before the cursor"
        , "go", "none", null, null]
    , ["B112 ]] is still the section motion", "]]", "x", "go", "position", 6, 0
        , "Forward to the next '{' at the line start"]
    , ["gJ join no space", "gJ", "Join this line with the line below (no space).", "go", "action", null, null]
    , ["2gJ join 2 lines no space", "2gJ", "Join 2 lines without a space.", "go", "action", null, null]
    , ["3rz replace 3 chars", "3rz", "Replace 3 characters under the cursor with 'z'.", "go", "action", null, null]
    , ["B094 2~ toggles 2 chars (Vim [count]~, change.txt:320)", "2~", "Toggle the case of 2 characters.", "go", "action", null, null]
    , ["B094 10~ toggles 10 chars", "10~", "Toggle the case of 10 characters.", "go", "action", null, null]
    , ["r: replace with a colon (no B083 collision)", "r:", "Replace the character under the cursor with ':'.", "go", "action", null, null]
    , ["3gJ join 3 lines no space", "3gJ", "Join 3 lines without a space.", "go", "action", null, null]
    // B086 r{char} accepts a space and an astral (surrogate-pair) char as ONE char
    , ["B086 r space replaces with a space", "r ", "Replace the character under the cursor with ' '.", "go", "action", null, null]
    , ["B086 3r space with a count", "3r ", "Replace 3 characters under the cursor with ' '.", "go", "action", null, null]
    , ["B088 r emoji is one char (needs /u)", "r😀", "Replace the character under the cursor with '😀'.", "go", "action", null, null]
    // B087 operator + bare ":" must not advertise a column ("\" still guides, B110)
    , ["B087 d: is dead -- no column guide", "d:", INVALID, "delete", "none", null, null]
    , ["B087 y: is dead -- no column guide", "y:", INVALID, "yank", "none", null, null]
    , ["B087 d\\ still guides for the column", "d\\", "Type the char to land on.", "delete", "none", null, null]
    // B108 "#" is no longer a delimiter -- it is Vim's backward word search, so `d#` is a real
    // motion now. The caret sits on the blank at col 3 of " a cdefg", so Vim's forward scan for a
    // word char picks "cdefg"; the only occurrence is that same one, reached by wrapping.
    , ["B108 d# is the Vim word search, not a column", "d#", "x", "delete", "position", 4, 3, "Previous whole word \"cdefg\""]
    // B083 range endpoint starting with ":" is Invalid too (use "\3" for a current-line column)
    , ["B083 range endpoint :3 is Invalid 5;:3", "5;:3", INVALID, "go", "none", null, null]
    // B089 [count]D / [count]C / [count]Y (change.txt:53, :199, :1074)
    , ["B089 2D == d2$", "2D", "x", "delete", "position", 5, 7, "End of line, 1 down"]
    , ["B089 2C == c2$", "2C", "x", "change", "position", 5, 7, "End of line, 1 down"]
    , ["B089 2Y == 2yy (linewise)", "2Y", "x", "yank", "position", 5, 2, "Down 1 line (5 + 1)"]
    // B090 g? rot13 operator + the long doubled synonyms + counts (change.txt:329-370)
    , ["B090 g?w rot13 a word", "g?w", "x", "rot13", "position", 4, 3, "Forward 1 word"]
    , ["B090 g?? whole line", "g??", "Rot13 encode the current line.", "rot13", "wholeLine", null, null]
    , ["B090 g?g? whole line synonym", "g?g?", "Rot13 encode the current line.", "rot13", "wholeLine", null, null]
    , ["B090 gugu == guu", "gugu", "Lowercase the current line.", "lowercase", "wholeLine", null, null]
    , ["B090 gUgU == gUU", "gUgU", "Uppercase the current line.", "uppercase", "wholeLine", null, null]
    , ["B090 g~g~ == g~~", "g~g~", "Toggle case of the current line.", "togglecase", "wholeLine", null, null]
    , ["B090 2guu == gu over 2 lines", "2guu", "x", "lowercase", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["B090 2g?? == g? over 2 lines", "2g??", "x", "rot13", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["B090 gu2u mid-count == 2guu", "gu2u", "x", "lowercase", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["B090 gu2gu mid-count == 2guu", "gu2gu", "x", "lowercase", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["B090 2guw == gu2w", "2guw", "x", "lowercase", "position", 5, 0, "Forward 2 words"]
    , ["B090 gu2w baseline", "gu2w", "x", "lowercase", "position", 5, 0, "Forward 2 words"]
    // B090 counts on both sides MULTIPLY (motion.txt:63-69): 2d2j = d4j, d2d = 2dd, 2d3d = 6dd
    , ["B090 2d2j == d4j (multiplied)", "2d2j", "x", "delete", "position", 8, 2, "Down 4 lines (5 + 4)"]
    , ["B090 d2d mid-count == 2dd", "d2d", "x", "delete", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["B090 2d3d == 6dd (multiplied)", "2d3d", "x", "delete", "position", 9, 2, "Down 5 lines (5 + 5)"]
    // B090 a count + operator with no motion yet guides instead of flashing Invalid
    , ["B090 2d pends for the target", "2d", "Type a target to delete.", "delete", "none", null, null]
    , ["B090 2gu pends for the target", "2gu", "Type a target to lowercase.", "lowercase", "none", null, null]
    // B091 z scroll one-shots (scroll.txt:113-144); z<CR> is untypeable (Enter submits the box)
    , ["B091 zz center, cursor kept", "zz", "Scroll: the current line to the center of the window.", "go", "action", null, null]
    , ["B091 zt top, cursor kept", "zt", "Scroll: the current line to the top of the window.", "go", "action", null, null]
    , ["B091 zb bottom, cursor kept", "zb", "Scroll: the current line to the bottom of the window.", "go", "action", null, null]
    , ["B091 z. center + first non-blank", "z.", "Scroll: the current line to the center of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B091 z- bottom + first non-blank", "z-", "Scroll: the current line to the bottom of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B091 5zt puts line 5 at the top", "5zt", "Scroll: line 5 to the top of the window.", "go", "action", null, null]
    , ["B091 10z. centers line 10 + moves", "10z.", "Scroll: line 10 to the center of the window, cursor to its first non-blank.", "go", "action", null, null]
    , ["B091 bare z pends (scroll OR fold now)", "z", "Type the next key after z.", "go", "none", null, null]
    , ["B091 2z pends too", "2z", "Type the next key after z.", "go", "none", null, null]
    // B100 z FOLD commands (fold.txt) -- distinct from the z SCROLL letters (t z b . -)
    , ["B100 zo opens the fold", "zo", "Open the fold under the cursor.", "go", "action", null, null]
    , ["B100 zO opens recursively", "zO", "Open the fold under the cursor, recursively.", "go", "action", null, null]
    , ["B100 zc closes the fold", "zc", "Close the fold under the cursor.", "go", "action", null, null]
    , ["B100 zC closes recursively", "zC", "Close the fold under the cursor, recursively.", "go", "action", null, null]
    , ["B100 za toggles the fold", "za", "Toggle the fold under the cursor.", "go", "action", null, null]
    , ["B100 zR opens every fold", "zR", "Open every fold.", "go", "action", null, null]
    , ["B100 zM closes every fold", "zM", "Close every fold.", "go", "action", null, null]
    , ["B100 zE removes manual folds", "zE", "Remove every manually created fold.", "go", "action", null, null]
    , ["B100 zj to the next fold", "zj", "Move down to the start of the next fold.", "go", "action", null, null]
    , ["B100 zk to the previous fold", "zk", "Move up to the end of the previous fold.", "go", "action", null, null]
    , ["B100 zv reveals the cursor line", "zv", "Open just enough folds to reveal the cursor line.", "go", "action", null, null]
    , ["B100 zq is not a fold key", "zq", INVALID, "go", "none", null, null]
    // B100 undo (undo.txt:22); Vim's redo is CTRL-R (untypeable) -> ::redo
    , ["B100 u undoes", "u", "Undo the last change.", "go", "action", null, null]
    , ["B100 :undo ex form", ":undo", "Undo the last change.", "go", "action", null, null]
    , ["B100 :redo ex form", ":redo", "Redo the undone change.", "go", "action", null, null]
    , ["B091 zx is not a scroll", "zx", INVALID, "go", "none", null, null]
    , ["B091 dz is dead (no operator + scroll)", "dz", INVALID, "delete", "none", null, null]
    // edge cases
    , ["'00' -> invalid (only '0' is line start)", "00", INVALID, "go", "none", null, null]
    , ["'ggg' -> invalid", "ggg", INVALID, "go", "none", null, null]
    , ["column out of range -> clamped char", "5:99", "x", "go", "position", 4, 8, "Line 5, char 9 (line end)"]
    // column percent N% -- char at N% of the line length (lines here are 8 chars)
    , ["col percent 5:50%", "5:50%", "x", "go", "position", 4, 4, "Line 5, at 50% of the line (char 5)"]
    , ["col percent colon 2:50%", "2:50%", "x", "go", "position", 1, 4, "Line 2, at 50% of the line (char 5)"]
    // B023: a standalone column percent capitalises ("At ..."); mid-sentence it stays lowercase ("at ...")
    , ["col percent standalone \\50%", "\\50%", "x", "go", "position", 4, 4, "At 50% of the line (char 5)"]
    , ["col percent 100% -> end 1:100%", "1:100%", "x", "go", "position", 0, 8, "Line 1, at 100% of the line (char 9)"]
    , ["col percent 0% -> start 1:0%", "1:0%", "x", "go", "position", 0, 0, "Line 1, at 0% of the line (char 1)"]
    , ["col percent 3 parts -> invalid", "2,50%:3", INVALID, "go", "none", null, null]
    , ["percent line + percent col 20%:50%", "20%:50%", "x", "go", "position", 1, 4, "At 20% of the file (line 2), at 50% of the line (char 5)"]
    // B015 -- the COLUMN axis gains the same percent arithmetic the line has: a percent column may take
    // an offset chain (`50%+2`), and a column may be a base char + a percent-of-line offset (`3+50%`).
    // Works after a plain line, a percent line, and a line+percent. A bad column stays Invalid.
    , ["B015 col percent + offset 5:50%+2", "5:50%+2", "x", "go", "position", 4, 6, "Line 5, at 50% of the line (char 5), then right 2 chars"]
    , ["B015 col base + percent offset 5:3+50%", "5:3+50%", "x", "go", "position", 4, 6, "Line 5, char 3, then right 50% of the line (4 chars)"]
    , ["B015 percent line + col percent+offset", "50%:50%+2", "x", "go", "position", 4, 6, "At 50% of the file (line 5), at 50% of the line (char 5), then right 2 chars"]
    , ["B015 line+pct + col base+pct 5+10%:3+25%", "5+10%:3+25%", "x", "go", "position", 5, 4, "Line 5, then down 10% of the file (1 line), char 3, then right 25% of the line (2 chars)"]
    , ["B015 col percent clamps 2:100%-1", "2:100%-1", "x", "go", "position", 1, 7, "Line 2, at 100% of the line (char 9), then left 1 char"]
    , ["B015 bad percent column -> invalid 5:50%x", "5:50%x", INVALID, "go", "none", null, null]
    // B017 -- the COLUMN gains SIGNED/relative percent (`+N%` / `-N%`, + chain), mirroring the line's
    // relative percent: move +/- N% of the line length from the cursor char. Closes the last line/col
    // percent asymmetry (the full matrix is now symmetric). Caret char 3 on an 8-char line.
    , ["B017 col +percent +50%", "6:+50%", "x", "go", "position", 5, 6, "Line 6, right 50% of the line (3 + 4)"]
    , ["B017 col -percent -50%", "6:-50%", "x", "go", "position", 5, 0, "Line 6, char 1 (line start)"]
    , ["B017 col signed percent + chain +50%+1", "6:+50%+1", "x", "go", "position", 5, 7, "Line 6, right 50% of the line (3 + 4), then right 1 char"]
    , ["B017 percent line + signed percent col", "50%:+50%", "x", "go", "position", 4, 6, "At 50% of the file (line 5), right 50% of the line (3 + 4)"]
    // B018: a signed/percent COLUMN now describes its move (Right/Left N% of the line) instead of a
    // bare "char K", mirroring the line axis -- both axes percent reads symmetrically.
    , ["B018 signed pct line + signed pct col", "+2%:+2%", "x", "go", "position", 4, 2, "Line 5, char 3"]
    // B026: a signed percent / signed base that overshoots an edge or nets zero reads the clamped
    // landing (boundNote) or "The current position", not a false direction with "(C +/- 0)".
    , ["B026 line +% overshoot last line", "+100%", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    // B106: a net-zero move keeps the COLUMN too (fixture caret is line 5 char 3 -> 4, 2).
    , ["B026/B106 line +0% net zero stays put", "+0%", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 -0% net zero stays put", "-0%", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 +50%-50% net zero stays put", "+50%-50%", "x", "go", "position", 4, 2, "The current position"]
    , ["B026 col -% clamps to start", "\\-50%", "x", "go", "position", 4, 0, "Char 1 (line start)"]
    , ["B026 col signed base clamps \\-10+50%", "\\-10+50%", "x", "go", "position", 4, 4, "Char 1 (line start), then right 50% of the line (4 chars)"]
    // B027: a percent chain folds into one percent (same axis base) -- exactly like an integer chain
    // collapses. `1%+1%` == `2%`, `10%+1+10%` == `20%+1`, `+50%-30%` == `+20%`. Line and column.
    , ["B027 line percent chain 1%+1%", "1%+1%", "x", "go", "position", 0, 0, "At 2% of the file (line 1)"]
    , ["B027 line percent+int+percent", "10%+1+10%", "x", "go", "position", 2, 0, "At 20% of the file (line 2), then down 1 line"]
    , ["B027 line signed percent chain", "+50%-30%", "x", "go", "position", 6, 0, "Down 20% of the file (5 + 2)"]
    , ["B027 col percent chain \\1%+1%", "\\1%+1%", "x", "go", "position", 4, 0, "At 2% of the line (char 1)"]
    , ["B027 col signed percent chain", "\\+50%-30%", "x", "go", "position", 4, 4, "Right 20% of the line (3 + 2)"]
    // B028: a signed offset that nets zero reads as the bare char / "Line N", not "right 0 chars (C + 0)".
    , ["B028 col net-zero \\+0", "\\+0", "x", "go", "position", 4, 2, "Char 3"]
    , ["B028 col net-zero \\+5-5", "\\+5-5", "x", "go", "position", 4, 2, "Char 3"]
    , ["B028 line net-zero +0:5", "+0:5", "x", "go", "position", 4, 4, "Line 5, char 5"]
    // B030: a motion cannot take a column, so `motion:` is Invalid, not a misleading column prompt;
    // a real line coordinate still pends for its column.
    , ["B030 motion+delim w: -> Invalid", "w:", INVALID, "go", "none", null, null]
    , ["B030 motion+delim gg: -> Invalid", "gg:", INVALID, "go", "none", null, null]
    , ["B030 line+delim 5: still pends", "5:", "Type the char to land on.", "go", "none", null, null]
    // B031: net-zero column via the percent:col / linePct:col branch (colTarget rel-chain) reads
    // "char N", not a trailing ", " (the colTarget half of B028).
    , ["B031 net-zero col via percent 50%:+0", "50%:+0", "x", "go", "position", 4, 2, "At 50% of the file (line 5), char 3"]
    , ["B031 net-zero col via linePct 5+10%:+0", "5+10%:+0", "x", "go", "position", 5, 2, "Line 5, then down 10% of the file (1 line), char 3"]
    // B032: a range separator only guides toward a second point for an operator that can USE a range;
    // indent/outdent/format/case + range-sep is Invalid (would be Invalid completed), not a range guide.
    // B032 gated these to Invalid because completing them was Invalid -- its concern was that the
    // pending guidance led to a DEAD END. B113 removed the dead end from the other side: indent /
    // format / case operators now take a range, so the guide is honest and the completion works.
    , ["B113 indent+range-sep now pends (completion is valid)", ">5;", "Type the second point of the range.", "indent", "none", null, null]
    , ["B113 case+range-sep now pends (completion is valid)", "gu5;", "Type the second point of the range.", "lowercase", "none", null, null]
    , ["B032 delete+range-sep still pends", "d5;", "Type the second point of the range.", "delete", "none", null, null]
    , ["B032 bare(go)+range-sep still pends", "5;", "Type the second point of the range.", "go", "none", null, null]
    // B055: a MOTION cannot be a range LEFT endpoint, so `motion;` / `motion~` is Invalid, not a "type
    // the second point" prompt -- the range-sep branch now probes the completed form (like B030 / B051).
    , ["B055 motion+range-sep gg; -> Invalid", "gg;", INVALID, "go", "none", null, null]
    , ["B055 motion+range-sep w~ -> Invalid", "w~", INVALID, "go", "none", null, null]
    , ["B055 motion+range-sep $; -> Invalid", "$;", INVALID, "go", "none", null, null]
    , ["B055 op + motion range-sep dgg; -> Invalid", "dgg;", INVALID, "delete", "none", null, null]
    , ["B055 coordinate+range-sep 50%; still pends", "50%;", "Type the second point of the range.", "go", "none", null, null]
    // B056: "0" is the start-of-line motion, never a line address -- a value-0 line base (0, 00, 0+2,
    // 0:+2, 0+10%) is Invalid, like any other motion + column. B057: a leading-zero VALUE normalises
    // (05 = line 5). B058: a signed / feature line + a trailing delimiter is mid-typing -> pends the
    // column. B059: a bare +/- as a range endpoint is the +/- motion, not a coordinate -> pends.
    , ["B056 value-0 line 0+2 -> Invalid", "0+2", INVALID, "go", "none", null, null]
    , ["B056 value-0 line 0:+2 -> Invalid", "0:+2", INVALID, "go", "none", null, null]
    , ["B056 value-0 line 0+10% -> Invalid", "0+10%", INVALID, "go", "none", null, null]
    , ["B056 value-0 line 00:+2 -> Invalid", "00:+2", INVALID, "go", "none", null, null]
    , ["B057 leading-zero 05 -> line 5", "05", "x", "go", "position", 4, 1, "Line 5 of the file"]
    , ["B057 leading-zero 05:+2 -> line 5", "05:+2", "x", "go", "position", 4, 4, "Line 5, right 2 chars (3 + 2)"]
    , ["B057 leading-zero 05% -> 5%", "05%", "x", "go", "position", 0, 0, "At 5% of the file (line 1)"]
    , ["B058 feature line + trailing colon 50+1: pends", "50+1:", "Type the char to land on.", "go", "none", null, null]
    , ["B059 bare sign range endpoint 5;+ pends", "5;+", "Type the number after the +/-.", "go", "none", null, null]
    , ["B059 bare sign range endpoint 5;- pends", "5;-", "Type the number after the +/-.", "go", "none", null, null]
    // B040: a range whose SECOND endpoint is mid-typing its column (trailing , or :) pends, like a single
    // target's trailing delimiter -- but only for a range-capable operator (non-range verb stays Invalid).
    , ["B040 range endpoint-B col pend 5;9:", "5;9:", "Type the column of the second point.", "go", "none", null, null]
    , ["B040 range endpoint-B col pend : 5;9:", "5;9:", "Type the column of the second point.", "go", "none", null, null]
    , ["B108 range endpoint-B # no longer pends 5;9#", "5;9#", INVALID, "go", "none", null, null]
    , ["B040 range line:col endpoint 5:5;9:", "5:5;9:", "Type the column of the second point.", "go", "none", null, null]
    , ["B040 percent endpoint 10%:3;9:", "10%:3;9:", "Type the column of the second point.", "go", "none", null, null]
    , ["B040 operator delete d5;9:", "d5;9:", "Type the column of the second point.", "delete", "none", null, null]
    , ["B040 operator change c5;9:", "c5;9:", "Type the column of the second point.", "change", "none", null, null]
    // Same reversal as the B032 pair above.
    , ["B113 indent range-endpoint column now pends", ">5;9:", "Type the column of the second point.", "indent", "none", null, null]
    , ["B113 case range-endpoint column now pends", "gu5;9:", "Type the column of the second point.", "lowercase", "none", null, null]
    // B041: an explicit-line column 0 clamps to char 1 (matching the empty-line form `,0`), not Invalid.
    , ["B041 explicit-line col 0 5:0 clamps", "5:0", "x", "go", "position", 4, 0, "Line 5, char 1 (line start)"]
    , ["B041 explicit-line col 0 3:0 clamps", "3:0", "x", "go", "position", 2, 0, "Line 3, char 1 (line start)"]
    // B043: a clamped percent OFFSET / CHAIN reads the ACTUAL distance moved, not the requested amount,
    // so it never claims a move that clamping swallowed (line axis + column axis, same family as B008/B026).
    , ["B043 line percent offset clamped +100%+5", "+100%+5", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    , ["B043 col percent chain clamped 5:50%+8", "5:50%+8", "x", "go", "position", 4, 8, "Line 5, at 50% of the line (char 5), then right 4 chars"]
    , ["B043 col standalone chain clamped \\50%+8", "\\50%+8", "x", "go", "position", 4, 8, "At 50% of the line (char 5), then right 4 chars"]
    , ["abs line, relative column 5:+3", "5:+3", "x", "go", "position", 4, 5, "Line 5, right 3 chars (3 + 3)"]
    , ["relative column clamps on a blank line 4:+3", "4:+3", "x", "go", "position", 3, 0, "Line 4, char 1 (line end)"]
    // an empty line part + an absolute column = current line, that column
    , ["empty line, abs col \\2", "\\2", "x", "go", "position", 4, 1, "Char 2"]
    // a mixed line:col note keeps the absolute axis label
    , ["abs line + rel col note 6:+2", "6:+2", "x", "go", "position", 5, 4, "Line 6, right 2 chars (3 + 2)"]
    , ["rel line + abs col note +4:4", "+4:4", "x", "go", "position", 8, 3, "Down 4 lines (5 + 4), char 4"]
    , ["B058 signed line + trailing colon +2: pends", "+2:", "Type the char to land on.", "go", "none", null, null]
    , ["word back count 2b (empty line idx3 counts as a word, B068)", "2b", "x", "go", "position", 3, 0, "Backward 2 words"]
    , ["delete word back db", "db", "x", "delete", "position", 4, 1, "Backward 1 word"]
    , ["delete word end de", "de", "x", "delete", "position", 4, 7, "Forward to the end of the word"]
    , ["delete relative backward d-2", "d-2", "x", "delete", "position", 2, 0, "Up 2 lines (5 - 2)"]
    , ["delete to first line dgg", "dgg", "x", "delete", "position", 0, 0, "First line of the file"]
    , ["yank to end of line y$", "y$", "x", "yank", "position", 4, 7, "At the end of the line"]
    , ["delete to bracket d%", "d%", "Delete to the matching bracket.", "delete", "bracket", null, null]
    , ["yank to bracket y%", "y%", "Copy to the matching bracket.", "yank", "bracket", null, null]
    // operator-cascade routing
    , ["bare case op -> target guide", "gu", "Type a target to lowercase.", "lowercase", "none", null, null]
    , ["case op gu + word w", "guw", "x", "lowercase", "position", 4, 3, "Forward 1 word"]
    , ["case op gU + end of line", "gU$", "x", "uppercase", "position", 4, 7, "At the end of the line"]
    , ["toggle case g~ + word", "g~w", "x", "togglecase", "position", 4, 3, "Forward 1 word"]
    , ["dd whole line", "dd", "Delete the current line.", "delete", "wholeLine", null, null]
    , ["yy whole line", "yy", "Copy the current line.", "yank", "wholeLine", null, null]
    , ["cc whole line", "cc", "Change the current line.", "change", "wholeLine", null, null]
    , [">> indent line", ">>", "Indent the current line.", "indent", "wholeLine", null, null]
    , ["== format line", "==", "Format the current line.", "format", "wholeLine", null, null]
    , ["indent to word >w", ">w", "x", "indent", "position", 4, 3, "Forward 1 word"]
    // j/k/h/l, ^, true WORD
    , ["down j", "j", "x", "go", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["down 3j", "3j", "x", "go", "position", 7, 0, "Down 3 lines (5 + 3)"]
    , ["up k", "k", "x", "go", "position", 3, 0, "Up 1 line (5 - 1)"]
    , ["right l", "l", "x", "go", "position", 4, 3, "Right 1 char (3 + 1)"]
    , ["left h", "h", "x", "go", "position", 4, 1, "Left 1 char (3 - 1)"]
    , ["right 2l", "2l", "x", "go", "position", 4, 4, "Right 2 chars (3 + 2)"]
    , ["delete down dj", "dj", "x", "delete", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["first non-blank ^", "^", "x", "go", "position", 4, 1, "At the first non-blank character"]
    , ["delete to ^", "d^", "x", "delete", "position", 4, 1, "At the first non-blank character"]
    // B054: Vim ignores any count on ^, so {count}^ == ^ (not Invalid); a doubled ^ stays Invalid.
    , ["B054 ^ ignores count 2^ == ^", "2^", "x", "go", "position", 4, 1, "At the first non-blank character"]
    , ["B054 ^ ignores count 99^", "99^", "x", "go", "position", 4, 1, "At the first non-blank character"]
    , ["B054 operator + count d2^ == d^", "d2^", "x", "delete", "position", 4, 1, "At the first non-blank character"]
    , ["B054 ^^ -> invalid", "^^", INVALID, "go", "none", null, null]
    // gM (% across line), | (go to column), g_ (last non-blank)
    , ["gM middle of line", "gM", "x", "go", "position", 4, 4, "At the middle of the line (char 5)"]
    , ["90gM percent of line", "90gM", "x", "go", "position", 4, 7, "At 90% of the line (char 8)"]
    , ["100gM clamps to last char", "100gM", "x", "go", "position", 4, 7, "At 100% of the line (char 8)"]
    , ["bar go to char |", "|", "x", "go", "position", 4, 0, "At char 1"]
    , ["bar go to char 5|", "5|", "x", "go", "position", 4, 4, "At char 5"]
    , ["bar char clamps 99| (Vim: last char, not past EOL)", "99|", "x", "go", "position", 4, 7, "At char 8"]
    , ["g_ last non-blank", "g_", "x", "go", "position", 4, 7, "At the last non-blank character"]
    , ["2g_ last non-blank +1 line", "2g_", "x", "go", "position", 5, 7, "At the last non-blank character"]
    , ["WORD W", "W", "x", "go", "position", 4, 3, "Forward 1 WORD"]
    , ["WORD B", "B", "x", "go", "position", 4, 1, "Backward 1 WORD"]
    , ["WORD E", "E", "x", "go", "position", 4, 7, "Forward to the end of the WORD"]
    , ["WORD 2W", "2W", "x", "go", "position", 5, 0, "Forward 2 WORDs"]
    , ["delete WORD dW", "dW", "x", "delete", "position", 4, 3, "Forward 1 WORD"]
    // ge/gE backward word-end, f/F/t/T find-char
    , ["gE end of prev WORD", "gE", "x", "go", "position", 4, 1, "Backward to the end of a WORD"]
    , ["ge end of prev word", "ge", "x", "go", "position", 4, 1, "Backward to the end of a word"]
    , ["find f e", "fe", "x", "go", "position", 4, 5, "Forward to \"e\""]
    , ["till t e", "te", "x", "go", "position", 4, 4, "Forward till before \"e\""]
    , ["find back F a", "Fa", "x", "go", "position", 4, 1, "Backward to \"a\""]
    , ["till back T a", "Ta", "x", "go", "position", 4, 2, "Backward till after \"a\""]
    , ["find c fc", "fc", "x", "go", "position", 4, 3, "Forward to \"c\""]
    , ["find not found -> msg", "fz", NF("z", "after"), "go", "none", null, null]
    , ["find backward not found Fz", "Fz", NF("z", "before"), "go", "none", null, null]
    , ["delete find dfe", "dfe", "x", "delete", "position", 4, 5, "Forward to \"e\""]
    // sentence ( ) , section [[ ]]
    // a paragraph start IS a sentence boundary -- `)` lands on "Hi" (idx8 c0), not mid-line
    , ["next sentence ) (empty line idx7 is a sentence stop, B069)", ")", "x", "go", "position", 7, 0, "Forward 1 sentence"]
    , ["prev sentence (", "(", "x", "go", "position", 4, 1, "Backward 1 sentence"]
    , ["count sentence 2) (empty line then para-start, B069)", "2)", "x", "go", "position", 8, 0, "Forward 2 sentences"]
    , ["count paragraph 2} (2nd } runs off EOF -> last char, B070)", "2}", "x", "go", "position", 9, 7, "Forward 2 paragraphs"]
    , ["next section ]] (to brace)", "]]", "x", "go", "position", 6, 0, "Forward to the next '{' at the line start"]
    , ["prev section [[ (to brace)", "[[", "x", "go", "position", 0, 0, "Backward to the previous '{' at the line start"]
    // ][ / [] step `}` in col 0; ]] / [[ are `{`-only
    , ["section to close ][", "][", "x", "go", "position", 9, 0, "Forward to the next '}' at the line start"]
    , ["section to close back []", "[]", "x", "go", "position", 0, 0, "Backward to the previous '}' at the line start"]
    // + / - / _ land on the first non-blank (count BEFORE the sign)
    , ["first non-blank down +", "+", "x", "go", "position", 5, 0, "Down 1 line, first non-blank"]
    , ["first non-blank up -", "-", "x", "go", "position", 3, 0, "Up 1 line, first non-blank"]
    , ["first non-blank _ (count-1 down)", "_", "x", "go", "position", 4, 1, "At the first non-blank character"]
    , ["first non-blank 2+", "2+", "x", "go", "position", 6, 0, "Down 2 lines, first non-blank"]
    // unmatched bracket jumps -- no matching bracket in this ctx -> the not-found message
    , ["unmatched close ]} not found", "]}", "No unmatched '}' after the cursor", "go", "none", null, null]
    , ["unmatched open [( not found", "[(", "No unmatched '(' before the cursor", "go", "none", null, null]
    // operators over a motion target
    , ["indent to j >j", ">j", "x", "indent", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["change to ^ c^", "c^", "x", "change", "position", 4, 1, "At the first non-blank character"]
    , ["uppercase WORD gUW", "gUW", "x", "uppercase", "position", 4, 3, "Forward 1 WORD"]
    // relative column CHAIN -- symmetric with the relative line chain
    , ["rel line + rel col chain", "+2:+2+2+2", "x", "go", "position", 6, 8, "Down 2 lines (5 + 2), right 6 chars (3 + 6)"]
    , ["abs line + rel col chain", "5:+2+2", "x", "go", "position", 4, 6, "Line 5, right 4 chars (3 + 4)"]
    , ["delete to rel col chain", "d+2:+2+2", "x", "delete", "position", 6, 6, "Down 2 lines (5 + 2), right 4 chars (3 + 4)"]
    // mixed-sign / empty-part column chains
    , ["mixed-sign col chain +2:-1", "+2:-1", "x", "go", "position", 6, 1, "Down 2 lines (5 + 2), left 1 char (3 - 1)"]
    , ["col chain nets +1 +2:-1+2", "+2:-1+2", "x", "go", "position", 6, 3, "Down 2 lines (5 + 2), right 1 char (3 + 1)"]
    , ["empty line, rel col \\+3", "\\+3", "x", "go", "position", 4, 5, "Right 3 chars (3 + 3)"]
    // absolute line / column base + offset chain (50+1, 8-2, 5:3+1)
    , ["abs line + offset 5+1", "5+1", "x", "go", "position", 5, 0, "Line 6 of the file"]
    , ["abs line - offset 8-2", "8-2", "x", "go", "position", 5, 0, "Line 6 of the file"]
    , ["abs line offset chain 5+1+1", "5+1+1", "x", "go", "position", 6, 0, "Line 7 of the file"]
    , ["abs line offset clamps 50+1", "50+1", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    , ["abs col + offset 5:3+1", "5:3+1", "x", "go", "position", 4, 3, "Line 5, char 4"]
    , ["abs line + abs col offsets 5+1:2+1", "5+1:2+1", "x", "go", "position", 5, 2, "Line 6, char 3"]
    , ["delete to abs line offset d5+1", "d5+1", "x", "delete", "position", 5, 0, "Line 6 of the file"]
    , ["junk 5+1x -> Invalid (strict fallback)", "5+1x", INVALID, "go", "none", null, null]
    // spaces around a delimiter must NOT revert a signed part to built-in negative-from-end
    , ["spaced rel line + col -1 : 2", "-1 : 2", "x", "go", "position", 3, 0, "Up 1 line (5 - 1), char 1 (line end)"]
    , ["spaced rel line + col -2 : 2", "-2 : 2", "x", "go", "position", 2, 1, "Up 2 lines (5 - 2), char 2"]
    , ["spaced rel line + rel col +2 : +3", "+2 : +3", "x", "go", "position", 6, 5, "Down 2 lines (5 + 2), right 3 chars (3 + 3)"]
    , ["spaced single relative  +2 ", " +2 ", "x", "go", "position", 6, 0, "Down 2 lines (5 + 2)"]
    , ["spaced abs line, rel col 5 : +3", "5 : +3", "x", "go", "position", 4, 5, "Line 5, right 3 chars (3 + 3)"]
    , ["spaced delete to rel line d-2 : 2", "d-2 : 2", "x", "delete", "position", 2, 1, "Up 2 lines (5 - 2), char 2"]
    // whitespace is insignificant -- each must equal its glued form
    , ["ws abs+offset 5 + 1", "5 + 1", "x", "go", "position", 5, 0, "Line 6 of the file"]
    , ["ws abs-offset 8 - 2", "8 - 2", "x", "go", "position", 5, 0, "Line 6 of the file"]
    , ["ws rel chain +5 + 5 clamps", "+5 + 5", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    , ["ws line+col 1 + 1: 1 + 1", "1 + 1: 1 + 1", "x", "go", "position", 1, 1, "Line 2, char 2"]
    , ["ws abs col 5 : 3 + 1", "5 : 3 + 1", "x", "go", "position", 4, 3, "Line 5, char 4"]
    , ["ws count motion 2 w", "2 w", "x", "go", "position", 5, 0, "Forward 2 words"]
    , ["ws count line 3 j", "3 j", "x", "go", "position", 7, 0, "Down 3 lines (5 + 3)"]
    , ["ws operator+count+motion d 2 w", "d 2 w", "x", "delete", "position", 5, 0, "Forward 2 words"]
    , ["ws doubled op d d", "d d", "Delete the current line.", "delete", "wholeLine", null, null]
    , ["ws case op g u w", "g u w", "x", "lowercase", "position", 4, 3, "Forward 1 word"]
    , ["ws doubled indent > >", "> >", "Indent the current line.", "indent", "wholeLine", null, null]
    // whitespace insignificant + % always means percent regardless of spacing: `5 %` == `5%`
    , ["percent + spaced offset 50% + 1", "50% + 1", "x", "go", "position", 5, 0, "At 50% of the file (line 5), then down 1 line"]
    , ["spaced % == percent 5 %", "5 %", "x", "go", "position", 0, 0, "At 5% of the file (line 1)"]
    , ["spaced % with col 5 %:3", "5 %:3", "x", "go", "position", 0, 2, "At 5% of the file (line 1), char 3"]
    // find a literal space target (C2 exception)
    , ["find a space F ", "F ", "x", "go", "position", 4, 0, "Backward to \" \""]
    // net-zero relative
    // B106: `+0` is not a move, so the caret keeps its COLUMN as well -- exactly like `1j1k`, which
    // has always stayed put. The old build reset the column to 0 while the note claimed otherwise.
    , ["B106 net-zero +0 stays put (column kept)", "+0", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 net-zero -0 stays put", "-0", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 net-zero +0+0 stays put", "+0+0", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 net-zero +5-5 stays put", "+5-5", "x", "go", "position", 4, 2, "The current position"]
    , ["B106 1j1k stays put (the reference behavior)", "1j1k", "x", "go", "position", 4, 2, "The current position"]
    // a REAL move still lands at column 0 -- the family rule is unchanged
    , ["B106 +1 still lands at column 0", "+1", "x", "go", "position", 5, 0, "Down 1 line (5 + 1)"]
    , ["B106 -1 still lands at column 0", "-1", "x", "go", "position", 3, 0, "Up 1 line (5 - 1)"]
    // hjkl combo: chained motions sum per axis; j/k -> line, h/l -> column
    , ["combo 2j1l", "2j1l", "x", "go", "position", 6, 3, "Down 2 lines (5 + 2), right 1 char (3 + 1)"]
    , ["combo nets down 1 2j1k", "2j1k", "x", "go", "position", 5, 2, "Down 1 line (5 + 1)"]
    , ["combo jl", "jl", "x", "go", "position", 5, 3, "Down 1 line (5 + 1), right 1 char (3 + 1)"]
    , ["combo delete d2j1l", "d2j1l", "x", "delete", "position", 6, 3, "Down 2 lines (5 + 2), right 1 char (3 + 1)"]
    // overshoot clamps with a Max/Min bound note instead of a silent mis-jump
    , ["col overshoot 99l -> last char (Vim: not past EOL)", "99l", "x", "go", "position", 4, 7, "Char 8 (line end)"]
    , ["line overshoot +100 -> last line", "+100", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    , ["line under -100 -> first line", "-100", "x", "go", "position", 0, 0, "Line 1 (first line)"]
    , ["col under \\-10 -> line start", "\\-10", "x", "go", "position", 4, 0, "Char 1 (line start)"]
    , ["abs line past end 99 -> last line", "99", "x", "go", "position", 9, 0, "Line 10 (last line)"]
    // strict fallback: a number with trailing junk is NOT salvaged -> Invalid
    , ["junk 3xyz -> Invalid", "3xyz", INVALID, "go", "none", null, null]
    , ["junk +5x -> Invalid", "+5x", INVALID, "go", "none", null, null]
    , ["junk 5@# -> Invalid", "5@#", INVALID, "go", "none", null, null]
    , ["count find not found d2fc", "d2fc", NF("c", "after"), "delete", "none", null, null]
    , ["find char not on line f,", "f,", NF(",", "after"), "go", "none", null, null]
    // count must be >= 1 -- "0" is start-of-line, never a count
    , ["count 0 rejected 0w", "0w", INVALID, "go", "none", null, null]
    , ["count 0 rejected 0j", "0j", INVALID, "go", "none", null, null]
    , ["count 0 rejected 0fc", "0fc", INVALID, "go", "none", null, null]
    , ["count 00 rejected 00w", "00w", INVALID, "go", "none", null, null]
    , ["multi-digit count 20w (overshoot -> last char of buffer, B048)", "20w", "x", "go", "position", 9, 7, "Forward 20 words"]
    , ["10w now lands exactly (empty lines idx3/idx7 count as words, B068)", "10w", "x", "go", "position", 9, 0, "Forward 10 words"]
    // a SECOND ":" after the box prefix is the Vim ex grammar (B093); repeated colons collapse
    // like Vim's cmdline (cmdline.txt:711-714), and ex `:5` / `:$` are the ex goto forms (:709)
    , ["B093 :d is ex :d = delete the line (change.txt:75)", ":d", "Delete the current line.", "delete", "wholeLine", null, null]
    , ["B093 :y is ex :y = yank the line (change.txt:1098)", ":y", "Copy the current line.", "yank", "wholeLine", null, null]
    , ["B093 : pends for the ex command", ":", "Type an ex command.", "go", "none", null, null]
    , ["B093 :w saves", ":w", "Save the file.", "go", "action", null, null]
    , ["B093 :write long form", ":write", "Save the file.", "go", "action", null, null]
    , ["B093 : w space tolerated", ": w", "Save the file.", "go", "action", null, null]
    , ["B093 :wa saves all", ":wa", "Save all files.", "go", "action", null, null]
    , ["B093 :q closes", ":q", "Close the editor.", "go", "action", null, null]
    , ["B093 :q! discards and closes", ":q!", "Discard the changes and close the editor.", "go", "action", null, null]
    , ["B093 :qa closes all", ":qa", "Close all editors.", "go", "action", null, null]
    , ["B093 :qa! unsupported (no verified discard-all)", ":qa!", INVALID, "go", "none", null, null]
    , ["B093 :wq saves + closes", ":wq", "Save the file and close the editor.", "go", "action", null, null]
    , ["B093 :x == :wq", ":x", "Save the file and close the editor.", "go", "action", null, null]
    , ["B093 :e! reverts", ":e!", "Reload the file, discarding the changes.", "go", "action", null, null]
    , ["B093 :sp splits down", ":sp", "Split the editor down.", "go", "action", null, null]
    , ["B093 :vs splits right", ":vs", "Split the editor right.", "go", "action", null, null]
    , ["B093 :$ is ex goto last line", ":$", "x", "go", "position", 9, 0, "Last line of the file"]
    , ["B093 :gg is NOT ex (motions stay out)", ":gg", INVALID, "go", "none", null, null]
    , ["B093 :quit long form", ":quit", "Close the editor.", "go", "action", null, null]
    , ["B093 :quit! long form", ":quit!", "Discard the changes and close the editor.", "go", "action", null, null]
    , ["B093 :qall long form", ":qall", "Close all editors.", "go", "action", null, null]
    , ["B093 :wall long form", ":wall", "Save all files.", "go", "action", null, null]
    , ["B093 :split long form", ":split", "Split the editor down.", "go", "action", null, null]
    , ["B093 :vsplit long form", ":vsplit", "Split the editor right.", "go", "action", null, null]
    , ["B093 :edit! long form", ":edit!", "Reload the file, discarding the changes.", "go", "action", null, null]
    , ["B093 :wq! == :wq", ":wq!", "Save the file and close the editor.", "go", "action", null, null]
    , ["B093 :xit == :wq", ":xit", "Save the file and close the editor.", "go", "action", null, null]
    // B104 -- the save-all+quit-all family and the tab / buffer / window commands. Verified against
    // Vim 9.2 (editing.txt, tabpage.txt, windows.txt) AND VSCodeVim v1.32.4, which implements every
    // one of them (reference/vscodevim/exCommandParser.ts + tab.ts).
    , ["B104 :wqa saves all + closes all", ":wqa", "Save all files and close all editors.", "go", "action", null, null]
    , ["B104 :wqall long form", ":wqall", "Save all files and close all editors.", "go", "action", null, null]
    , ["B104 :xa == :wqa", ":xa", "Save all files and close all editors.", "go", "action", null, null]
    , ["B104 :xall == :wqa", ":xall", "Save all files and close all editors.", "go", "action", null, null]
    , ["B104 :exi == :wq", ":exi", "Save the file and close the editor.", "go", "action", null, null]
    , ["B104 :exit == :wq", ":exit", "Save the file and close the editor.", "go", "action", null, null]
    , ["B104 :quita == :qa", ":quita", "Close all editors.", "go", "action", null, null]
    , ["B104 :quitall == :qa", ":quitall", "Close all editors.", "go", "action", null, null]
    , ["B104 :w! == :w", ":w!", "Save the file.", "go", "action", null, null]
    , ["B104 :tabe opens an editor", ":tabe", "Open a new editor.", "go", "action", null, null]
    , ["B104 :tabnew == :tabe", ":tabnew", "Open a new editor.", "go", "action", null, null]
    , ["B104 :tabedit long form", ":tabedit", "Open a new editor.", "go", "action", null, null]
    , ["B104 :tabc closes", ":tabc", "Close the editor.", "go", "action", null, null]
    , ["B104 :tabclose long form", ":tabclose", "Close the editor.", "go", "action", null, null]
    , ["B104 :tabo closes others", ":tabo", "Close every other editor.", "go", "action", null, null]
    , ["B104 :tabonly long form", ":tabonly", "Close every other editor.", "go", "action", null, null]
    , ["B104 :tabn next", ":tabn", "Go to the next editor.", "go", "action", null, null]
    , ["B104 :tabnext long form", ":tabnext", "Go to the next editor.", "go", "action", null, null]
    , ["B104 :tabp previous", ":tabp", "Go to the previous editor.", "go", "action", null, null]
    , ["B104 :tabprevious long form", ":tabprevious", "Go to the previous editor.", "go", "action", null, null]
    , ["B104 :tabfir first", ":tabfir", "Go to the first editor.", "go", "action", null, null]
    , ["B104 :tablast last", ":tablast", "Go to the last editor.", "go", "action", null, null]
    // the buffer names share the tab behavior, exactly as VSCodeVim wires them
    , ["B104 :bn == :tabn", ":bn", "Go to the next editor.", "go", "action", null, null]
    , ["B104 :bnext long form", ":bnext", "Go to the next editor.", "go", "action", null, null]
    , ["B104 :bp == :tabp", ":bp", "Go to the previous editor.", "go", "action", null, null]
    , ["B104 :bprevious long form", ":bprevious", "Go to the previous editor.", "go", "action", null, null]
    , ["B104 :bf first", ":bf", "Go to the first editor.", "go", "action", null, null]
    , ["B104 :bl last", ":bl", "Go to the last editor.", "go", "action", null, null]
    , ["B104 :bd closes", ":bd", "Close the editor.", "go", "action", null, null]
    , ["B104 :bdelete long form", ":bdelete", "Close the editor.", "go", "action", null, null]
    // window family
    , ["B104 :clo closes", ":clo", "Close the editor.", "go", "action", null, null]
    , ["B104 :close long form", ":close", "Close the editor.", "go", "action", null, null]
    , ["B104 :on keeps only this", ":on", "Keep only this editor.", "go", "action", null, null]
    , ["B104 :only long form", ":only", "Keep only this editor.", "go", "action", null, null]
    , ["B104 :new splits down", ":new", "Split down and open a new editor.", "go", "action", null, null]
    , ["B104 :vne splits right", ":vne", "Split right and open a new editor.", "go", "action", null, null]
    , ["B104 :vnew long form", ":vnew", "Split right and open a new editor.", "go", "action", null, null]
    , ["B104 :ene new empty", ":ene", "Open a new empty editor.", "go", "action", null, null]
    , ["B104 :enew long form", ":enew", "Open a new empty editor.", "go", "action", null, null]
    // B104 -- deliberately NOT built; each stays Invalid for the reason recorded above EX_ALIAS
    , ["B104 :qa! needs a revert LOOP -> Invalid", ":qa!", INVALID, "go", "none", null, null]
    , ["B104 :e (no bang) would discard -> Invalid", ":e", INVALID, "go", "none", null, null]
    , ["B104 :noh has no VS Code analog -> Invalid", ":noh", INVALID, "go", "none", null, null]
    , ["B104 :n arglist has no analog -> Invalid", ":n", INVALID, "go", "none", null, null]
    , ["B104 :ls prints a list -> Invalid", ":ls", INVALID, "go", "none", null, null]
    , ["B104 :tabm takes an argument -> Invalid", ":tabm", INVALID, "go", "none", null, null]
    // not Vim at all (checked against Vim 9.2 + Neovim + VSCodeVim's 549-command table)
    , ["B104 :waq is not a Vim command", ":waq", INVALID, "go", "none", null, null]
    , ["B104 :x! is not a Vim command", ":x!", INVALID, "go", "none", null, null]
    , ["B104 :bprev is not a Vim command", ":bprev", INVALID, "go", "none", null, null]
    // B098 ex RANGE commands (change.txt: :d 76, :j 135, :< 516, :> 527, :s 648, :y 1099, :co 1421,
    // :m 1431, :sort 1913; addresses per cmdline.txt *:range*). Fixture = 10 lines, cursor line 5.
    , ["B098 :2d = delete line 2", ":2d", "Delete line 2.", "go", "action", null, null]
    , ["B098 :1,5y yank lines 1-5", ":1,5y", "Yank lines 1-5.", "go", "action", null, null]
    , ["B098 :3,7d delete lines 3-7", ":3,7d", "Delete lines 3-7.", "go", "action", null, null]
    , ["B098 :5y single-line yank", ":5y", "Yank line 5.", "go", "action", null, null]
    , ["B098 :%d whole buffer", ":%d", "Delete lines 1-10.", "go", "action", null, null]
    , ["B098 :$y last line", ":$y", "Yank line 10.", "go", "action", null, null]
    , ["B098 :.,$d current to last", ":.,$d", "Delete lines 5-10.", "go", "action", null, null]
    , ["B098 :1,5 bare range -> goto last (line 5)", ":1,5", "x", "go", "position", 4, 1, "Line 5 of the file"]
    // the new range verbs: join / shift / sort / move / copy / substitute
    , ["B098 :1,9j joins the span", ":1,9j", "Join lines 1-9.", "go", "action", null, null]
    , ["B098 :j (no range) = the current line", ":j", "Join line 5.", "go", "action", null, null]
    , ["B098 :1,5> indents the span", ":1,5>", "Indent lines 1-5.", "go", "action", null, null]
    , ["B098 :1,5< outdents the span", ":1,5<", "Outdent lines 1-5.", "go", "action", null, null]
    , ["B098 :1,9sort sorts the span", ":1,9sort", "Sort lines 1-9.", "go", "action", null, null]
    , ["B098 :%sort sorts the buffer", ":%sort", "Sort lines 1-10.", "go", "action", null, null]
    , ["B098 :1,3m8 moves the span", ":1,3m8", "Move lines 1-3 to after line 8.", "go", "action", null, null]
    , ["B098 :1,3t8 copies the span", ":1,3t8", "Copy lines 1-3 to after line 8.", "go", "action", null, null]
    , ["B098 :1,3co8 copy long form", ":1,3co8", "Copy lines 1-3 to after line 8.", "go", "action", null, null]
    , ["B098 :%s/a/b/g substitutes the buffer", ":%s/a/b/g", "Substitute in lines 1-10.", "go", "action", null, null]
    , ["B098 :1,5s/a/b/ substitutes the span", ":1,5s/a/b/", "Substitute in lines 1-5.", "go", "action", null, null]
    , ["B098 :s/old/new/ (no range) = current line", ":s/old/new/", "Substitute in line 5.", "go", "action", null, null]
    , ["B098 :s/ pends for the pattern", ":s/", "Type the pattern and the replacement.", "go", "none", null, null]
    , ["B098 :1,19s (no pattern) is Invalid", ":1,19s", INVALID, "go", "none", null, null]
    , ["B098 :5w (write one line) unsupported", ":5w", INVALID, "go", "none", null, null]
    , ["B093 :d5 (cmd before addr) still Invalid", ":d5", INVALID, "go", "none", null, null]
    , ["B093 :y5 (cmd before addr) still Invalid", ":y5", INVALID, "go", "none", null, null]
    , ["B093 :00 is not a line", ":00", INVALID, "go", "none", null, null]
    // B090 count multiply on a PURE-NUMBER motion (2d21 == d42, like Vim 2d21G) -- the two-digit
    // form needs the 50-line custom fixture; the in-fixture single digit checks the same path
    , ["B090 2d3 == d6 (count x line address)", "2d3", "x", "delete", "position", 5, 0, "Line 6 of the file"]
    , ["B090 2gu3 == gu6", "2gu3", "x", "lowercase", "position", 5, 0, "Line 6 of the file"]
    , ["B093 :10:10 is NOT ex (no line:col in ex)", ":10:10", INVALID, "go", "none", null, null]
    , ["B093 :,5 is NOT ex (a column form)", ":,5", INVALID, "go", "none", null, null]
    , ["B093 :0 is not a line", ":0", INVALID, "go", "none", null, null]
    , ["B093 d:1 unaffected (B083 guard)", "d::1", INVALID, "delete", "none", null, null]
    , ["d alone pends for its target (no prefix to strip since B105)", "d", "Type a target to delete.", "delete", "none", null, null]
    // B105: exactly ONE leading colon is the ex prefix. The old build collapsed repeated colons
    // (so `::5` reached line 5); that only existed because the box prefilled one, and the help
    // passage it cited actually documents a colon BETWEEN range and command, not repeated leading
    // ones. A second colon is now a dead input.
    , ["B105 :: is Invalid (was the prefill artifact)", "::", INVALID, "go", "none", null, null]
    , ["B105 ::5 is Invalid", "::5", INVALID, "go", "none", null, null]
    , ["B105 ::w is Invalid", "::w", INVALID, "go", "none", null, null]
    , ["B105 :5 is the ex goto -> line 5", ":5", "x", "go", "position", 4, 1, "Line 5 of the file"]
    // B083: a target that STARTS with ":" is Invalid. The leading ":" is the box prefix (stripped only
    // at the very front of the whole value for line-addressing, `::10:10` -> `10:10`); it is not a target
    // head, so an operator + a bare ":" is Invalid, NOT line 1 (reverses B082). "," DOES start a
    // current-line column and stays valid; a real line:col (`d10:5`) stays valid.
    , ["B083 op leading colon d:1 -> Invalid", "d:1", INVALID, "delete", "none", null, null]
    , ["B083 op double colon d:1 -> Invalid", "d::1", INVALID, "delete", "none", null, null]
    , ["B083 op leading colon + col d:1:1 -> Invalid", "d:1:1", INVALID, "delete", "none", null, null]
    , ["B083 op leading colon percent y:50% -> Invalid", "y:50%", INVALID, "yank", "none", null, null]
    , ["B083 op leading colon range d:5;9 -> Invalid", "d:5;9", INVALID, "delete", "none", null, null]
    , ["B083 backslash still current-line col d\\1", "d\\1", "x", "delete", "position", 4, 0, "Char 1"]
    , ["B108 hash no longer a current-line col d#1", "d#1", INVALID, "delete", "none", null, null]
    , ["B083 real line:col after op still valid d10:5", "d10:5", "x", "delete", "position", 9, 4, "Line 10, char 5"]
    // doubled case operator -> whole current line (Vim guu / gUU / g~~)
    , ["guu lowercase line", "guu", "Lowercase the current line.", "lowercase", "wholeLine", null, null]
    , ["gUU uppercase line", "gUU", "Uppercase the current line.", "uppercase", "wholeLine", null, null]
    , ["g~~ toggle case line", "g~~", "Toggle case of the current line.", "togglecase", "wholeLine", null, null]
    // two-coordinate range A;B -- ";" ONLY since B094 (`~` = Vim toggle; `>` is the indent operator, NOT a
    // separator -- B024); endpoints are absolute line:col
    , ["range select 5:5;5:9", "5:5;5:9", "Select line 5 and char 5 to line 5 and char 9.", "go", "range", null, null, "From line 5 char 5 to line 5 char 9"]
    , ["B094 '~' is NOT a range separator 5:5~5:9", "5:5~5:9", INVALID, "go", "none", null, null]
    , ["B074 range % endpoint -> col 1 (not first-non-blank)", "50%;9", "Select line 5 and char 1 to line 9 and char 1.", "go", "range", null, null, "From line 5 char 1 to line 9 char 1"]
    , ["B024 '>' is NOT a range separator 5:5>5:9", "5:5>5:9", INVALID, "go", "none", null, null]
    , ["B024 indent + range rejected >30~20", ">30~20", INVALID, "indent", "none", null, null]
    , ["range yank y5:5;5:9", "y5:5;5:9", "Copy line 5 and char 5 to line 5 and char 9.", "yank", "range", null, null, "From line 5 char 5 to line 5 char 9"]
    , ["B094 operator + '~' range is dead d5:5~5:9", "d5:5~5:9", INVALID, "delete", "none", null, null]
    , ["range change c2:2;6:8", "c2:2;6:8", "Change line 2 and char 2 to line 6 and char 8.", "change", "range", null, null, "From line 2 char 2 to line 6 char 8"]
    , ["range line-only 5;9", "5;9", "Select line 5 and char 1 to line 9 and char 1.", "go", "range", null, null, "From line 5 char 1 to line 9 char 1"]
    , ["range clamps col 5:5;5:99", "5:5;5:99", "Select line 5 and char 5 to line 5 and char 9.", "go", "range", null, null, "From line 5 char 5 to line 5 char 9"]
    , ["range clamps line 99:5;5:5", "99:5;5:5", "Select line 10 and char 5 to line 5 and char 5.", "go", "range", null, null, "From line 10 char 5 to line 5 char 5"]
    , ["range 3 parts -> invalid 5;6;7", "5;6;7", INVALID, "go", "none", null, null]
    , ["range half -> pending 5;", "5;", "Type the second point of the range.", "go", "none", null, null]
    // B094: a trailing `~` is never a half range anymore -- `5~` IS the complete toggle command
    , ["B094 5~ toggles 5 chars (not a range half)", "5~", "Toggle the case of 5 characters.", "go", "action", null, null]
    , ["B094 d5~ is dead (operator + standalone)", "d5~", INVALID, "delete", "none", null, null]
    , ["B094 -1~ is dead (no count shape)", "-1~", INVALID, "go", "none", null, null]
    , ["B025 5> is NOT a range half -- it pends as count+indent (5>> works)", "5>", "Type a target to indent.", "indent", "none", null, null]
    , ["range needs left end ;5", ";5", INVALID, "go", "none", null, null]
    // B016 -- a range endpoint accepts the full coordinate grammar (absolute / relative / offset /
    // percent); a relative SECOND point counts from the first point A. Motions are still rejected.
    , ["B016 range relative end 5;+2", "5;+2", "Select line 5 and char 1 to line 7 and char 1.", "go", "range", null, null, "From line 5 char 1 to line 7 char 1"]
    , ["B016 range relative line:col end 5:5;+2:9", "5:5;+2:9", "Select line 5 and char 5 to line 7 and char 9.", "go", "range", null, null, "From line 5 char 5 to line 7 char 9"]
    , ["B016 range offset end 5:5;5+1:9", "5:5;5+1:9", "Select line 5 and char 5 to line 6 and char 9.", "go", "range", null, null, "From line 5 char 5 to line 6 char 9"]
    , ["B016 range percent end 2:2;50%:9", "2:2;50%:9", "Select line 2 and char 2 to line 5 and char 9.", "go", "range", null, null, "From line 2 char 2 to line 5 char 9"]
    , ["B016 range op + relative end d5:5;+2:9", "d5:5;+2:9", "Delete line 5 and char 5 to line 7 and char 9.", "delete", "range", null, null, "From line 5 char 5 to line 7 char 9"]
    , ["B016 range motion end rejected 5:5;w", "5:5;w", INVALID, "go", "none", null, null]
    , ["B016 range motion end rejected 1:1;gg", "1:1;gg", INVALID, "go", "none", null, null]
    // B036 -- a percent FIRST endpoint with a column (`10%:3;5`) was swallowed by the percent column
    // group before the range split (it ran before the range check), so the LEFT endpoint rejected
    // `percent:col` while the RIGHT one (B016) accepted it. The range check now runs before percent.
    , ["B036 percent:col first endpoint 10%:3;5", "10%:3;5", "Select line 1 and char 3 to line 5 and char 1.", "go", "range", null, null, "From line 1 char 3 to line 5 char 1"]
    , ["B036 percent:col both endpoints 50%:2;60%:4", "50%:2;60%:4", "Select line 5 and char 2 to line 6 and char 4.", "go", "range", null, null, "From line 5 char 2 to line 6 char 4"]
    , ["B036 percent-chain:col first endpoint", "10%+1+10%-1:20;20", "Select line 2 and char 9 to line 10 and char 1.", "go", "range", null, null, "From line 2 char 9 to line 10 char 1"]
    , ["B036 op + percent:col first endpoint d50%:2;60%:4", "d50%:2;60%:4", "Delete line 5 and char 2 to line 6 and char 4.", "delete", "range", null, null, "From line 5 char 2 to line 6 char 4"]
    , ["f; is find ';' not a range", "f;", NF(";", "after"), "go", "none", null, null]
    // pending-state guidance: a valid PREFIX still being typed shows a guide, not "Invalid"
    , ["find prefix f", "f", "Type a character to jump to it on this line.", "go", "none", null, null]
    , ["find prefix combo df", "df", "Type a character to jump to it on this line.", "delete", "none", null, null]
    , ["find prefix count 2f", "2f", "Type a character to jump to it on this line.", "go", "none", null, null]
    , ["bracket prefix [", "[", "Type a bracket to jump to its opener.", "go", "none", null, null]
    , ["bracket prefix ]", "]", "Type a bracket to jump to its closer.", "go", "none", null, null]
    , ["bracket prefix combo d[", "d[", "Type a bracket to jump to its opener.", "delete", "none", null, null]
    , ["trailing colon 5:", "5:", "Type the char to land on.", "go", "none", null, null]
    // "," used to pend for a current-line column; B110 gave it back to Vim (FIND_REPEAT_CASES /
    // FIND_REPEAT_MISS_CASES below cover its real behavior now).
    , ["percent trailing colon 50%:", "50%:", "Type the char to land on.", "go", "none", null, null]
    , ["line+pct trailing colon 5+10%:", "5+10%:", "Type the char to land on.", "go", "none", null, null]
    , ["range full first 5:5;", "5:5;", "Type the second point of the range.", "go", "none", null, null]
    // B110 review fix: a bare "\" awaiting its column used to only match as the WHOLE spec, so a
    // range's SECOND point ("5;\") wrongly fell through to "Invalid input" instead of pending.
    , ["B110 backslash pends as range 2nd point 5;\\", "5;\\", "Type the column of the second point."
        , "go", "none", null, null]
    , ["B110 backslash pends as range 2nd point 10:9;\\", "10:9;\\", "Type the column of the second point."
        , "go", "none", null, null]
    , ["B110 backslash pends under an operator d5;\\", "d5;\\", "Type the column of the second point."
        , "delete", "none", null, null]
    , ["dangling sign +5+", "+5+", "Type the number after the +/-.", "go", "none", null, null]
    , ["dangling col sign 5:+", "5:+", "Type the number after the +/-.", "go", "none", null, null]
    // B051: a dangling sign after a MOTION base is Invalid, not a "type a number" guide -- a motion
    // takes no numeric offset, so completing it (`w+2`) is Invalid; guide only toward a base that can.
    , ["B051 motion+sign w+ -> Invalid", "w+", INVALID, "go", "none", null, null]
    , ["B051 motion+sign 1j+ -> Invalid", "1j+", INVALID, "go", "none", null, null]
    , ["B051 motion-chain+sign 1j1k1l1h+ -> Invalid", "1j1k1l1h+", INVALID, "go", "none", null, null]
    , ["B051 double sign 5++ -> Invalid", "5++", INVALID, "go", "none", null, null]
    , ["B051 percent+sign 50%+ still pends", "50%+", "Type the number after the +/-.", "go", "none", null, null]
    // truly dead -> still Invalid (contrast)
    // Was "dead a -> invalid". Superseded: `a` is Vim's append-after-cursor (index.txt:387), a real
    // Normal-mode command, not a dangling text-object prefix. The old case encoded the reason it
    // went unbuilt, not a requirement.
    , ["a appends after the cursor", "a", "Go to line 5 and char 4.", "go", "position", 4, 3]
    , ["dead g9 -> invalid", "g9", INVALID, "go", "none", null, null]
    , ["dead [x -> invalid", "[x", INVALID, "go", "none", null, null]
];

// Cases needing a fixture the shared LINES/ctx cannot express (own buffer shape or line length).
// [ description, ctx, value, line, character, note? ]
const FIFTY = {
    totalLines    : 50, currentLine   : 0, currentChar   : 0
    , lineLength    : () => 8, lineText      : () => "abcdefgh"
    , viewportTop   : 0, viewportBottom: 20
};
// B106: the caret ALREADY at char 1 -- "stay put" and "reset to column 0" land identically here, so
// these guard the other side of the conditional (a regression that always reset would still pass the
// char-3 cases only if it also broke these).
const AT_COL_1 = {
    totalLines    : 10, currentLine   : 4, currentChar   : 0
    , lineLength    : () => 8, lineText      : () => "abcdefgh"
    , viewportTop   : 2, viewportBottom: 8
};

const CUSTOM_CTX_CASES = [
    ["B106 +0 at char 1 -> unchanged", AT_COL_1, "+0", 4, 0, "The current position"]
    , ["B106 +5-5 at char 1 -> unchanged", AT_COL_1, "+5-5", 4, 0, "The current position"]
    , ["B106 +0% at char 1 -> unchanged", AT_COL_1, "+0%", 4, 0, "The current position"]
    , ["B106 +1 at char 1 still moves to column 0", AT_COL_1, "+1", 5, 0, "Down 1 line (5 + 1)"]
    // B090: a two-digit pure-number motion multiplies WHOLE (2d21 == d42) -- the old regex
    // backtracked and produced d41 (2x2 then a literal "1"); needs > 42 lines to stay unclamped.
    ,["B090 2d21 == d42 (no backtrack split)", FIFTY, "2d21", 41, 0, "Line 42 of the file"]
    , ["B090 2gu21 == gu42 (g-op branch)", FIFTY, "2gu21", 41, 0, "Line 42 of the file"]
    , ["B090 3d12 == d36", FIFTY, "3d12", 35, 0, "Line 36 of the file"]
    // B049: a sentence-ending line's next line starts the new sentence at its first non-blank,
    // not a hardcoded char 0.
    ,["B049 sentence crosses into an indented line", {
        totalLines    : 2, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["Hi.", "   Bye."][i].length
        , lineText      : (i) => ["Hi.", "   Bye."][i]
        , viewportTop   : 0, viewportBottom: 1
    }, ")", 1, 3, "Forward 1 sentence"]
    // B052: gg / {count}gg / G / {count}G land on the FIRST NON-BLANK of the target line (Vim), not
    // char 0 -- an indented first / target line exposes it (shared fixture lines are unindented).
    , ["B052 gg lands on first non-blank (indented line 1)", {
        totalLines    : 3, currentLine   : 1, currentChar   : 0
        , lineLength    : (i) => ["   aaa", "bbb", "  cc"][i].length
        , lineText      : (i) => ["   aaa", "bbb", "  cc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "gg", 0, 3, "First line of the file"]
    , ["B052 3G lands on first non-blank (indented last line)", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["   aaa", "bbb", "  cc"][i].length
        , lineText      : (i) => ["   aaa", "bbb", "  cc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "3G", 2, 2, "Line 3, first non-blank"]
    // B053: H / M / L land on the FIRST NON-BLANK of the target window line (Vim), not char 0 --
    // an indented window top / middle / bottom line exposes it.
    , ["B053 H lands on first non-blank (indented top line)", {
        totalLines    : 3, currentLine   : 1, currentChar   : 0
        , lineLength    : (i) => ["  aa", "bb", "   cc"][i].length
        , lineText      : (i) => ["  aa", "bb", "   cc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "H", 0, 2, "Top line of the window"]
    , ["B053 L lands on first non-blank (indented bottom line)", {
        totalLines    : 3, currentLine   : 1, currentChar   : 0
        , lineLength    : (i) => ["  aa", "bb", "   cc"][i].length
        , lineText      : (i) => ["  aa", "bb", "   cc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "L", 2, 3, "Bottom line of the window"]
    , ["B053 M lands on first non-blank (indented middle line)", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["a", "  mid", "c"][i].length
        , lineText      : (i) => ["a", "  mid", "c"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "M", 1, 2, "Middle line of the window"]
    // B044: a signed percent column rounds the MAGNITUDE then re-signs, so +N% and -N% move the
    // same distance (a length-10 line exposes the old asymmetry; the shared fixture is length-8).
    , ["B044 signed percent +15% (len-10 line)", {
        totalLines    : 1, currentLine   : 0, currentChar   : 5
        , lineLength    : (i) => ["abcdefghij"][i].length
        , lineText      : (i) => ["abcdefghij"][i]
        , viewportTop   : 0, viewportBottom: 0
    }, "\\+15%", 0, 7, "Right 15% of the line (6 + 2)"]
    , ["B044 signed percent -15% (len-10 line)", {
        totalLines    : 1, currentLine   : 0, currentChar   : 5
        , lineLength    : (i) => ["abcdefghij"][i].length
        , lineText      : (i) => ["abcdefghij"][i]
        , viewportTop   : 0, viewportBottom: 0
    }, "\\-15%", 0, 3, "Left 15% of the line (6 - 2)"]
    // B095: a net-zero PERCENT column offset drops its clause (no "then right 0% ... (0 chars)"),
    // leaving just the base + the real chain tail. len-10 fixture; cursor char 0.
    , ["B095 base+netzero% col drops the 0% clause", {
        totalLines    : 1, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["abcdefghij"][i].length
        , lineText      : (i) => ["abcdefghij"][i]
        , viewportTop   : 0, viewportBottom: 0
    }, "1:2+1%-1%-1", 0, 0, "Line 1, char 2, then left 1 char"]
    , ["B095 base+0% col reads the bare char", {
        totalLines    : 1, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["abcdefghij"][i].length
        , lineText      : (i) => ["abcdefghij"][i]
        , viewportTop   : 0, viewportBottom: 0
    }, "1:3+0%", 0, 2, "Line 1, char 3"]
    // B096: ge/gE carry the count in the description (2ge != ge), like E. Mid-buffer so the target
    // differs; the 5-word line puts the cursor on "epsilon".
    , ["B096 2ge shows the count in the note", {
        totalLines    : 1, currentLine   : 0, currentChar   : 26
        , lineLength    : () => "alpha beta gamma delta epsilon".length
        , lineText      : () => "alpha beta gamma delta epsilon"
        , viewportTop   : 0, viewportBottom: 0
    }, "2ge", 0, 15, "Backward to the end of word 2"]
    , ["B096 2gE shows the count in the note", {
        totalLines    : 1, currentLine   : 0, currentChar   : 26
        , lineLength    : () => "alpha beta gamma delta epsilon".length
        , lineText      : () => "alpha beta gamma delta epsilon"
        , viewportTop   : 0, viewportBottom: 0
    }, "2gE", 0, 15, "Backward to the end of WORD 2"]
    // B050: ) with no next sentence stops at the END of the buffer (a forward motion never moves
    // backward, Vim); the end-of-buffer stop is forward-only, so ( is unaffected.
    , ["B050 ) inside the last sentence clamps to the buffer end", {
        totalLines    : 1, currentLine   : 0, currentChar   : 6
        , lineLength    : (i) => ["Hi. Bye."][i].length
        , lineText      : (i) => ["Hi. Bye."][i]
        , viewportTop   : 0, viewportBottom: 0
    }, ")", 0, 7, "Forward 1 sentence"]
    , ["B050 ) on the last sentence start goes to the buffer end", {
        totalLines    : 1, currentLine   : 0, currentChar   : 4
        , lineLength    : (i) => ["Hi. Bye."][i].length
        , lineText      : (i) => ["Hi. Bye."][i]
        , viewportTop   : 0, viewportBottom: 0
    }, ")", 0, 7, "Forward 1 sentence"]
    , ["B050 ) tail clamp on a multi-line buffer", {
        totalLines    : 2, currentLine   : 1, currentChar   : 8
        , lineLength    : (i) => ["One. Two.", "Three. Four."][i].length
        , lineText      : (i) => ["One. Two.", "Three. Four."][i]
        , viewportTop   : 0, viewportBottom: 1
    }, ")", 1, 11, "Forward 1 sentence"]
    // B061: first-non-blank cursor motions (gg G ^ H M L + - _) land on the LAST whitespace char of
    // an ALL-WHITESPACE target line (Vim beginline + BL_FIX), not char 0. Empty "" line -> char 0.
    // Regression guard: a line with real text is UNCHANGED (still lands on the first non-blank).
    , ["B061 gg on an all-whitespace first line -> last space", {
        totalLines    : 3, currentLine   : 2, currentChar   : 0
        , lineLength    : (i) => ["    ", "bbb", "ccc"][i].length
        , lineText      : (i) => ["    ", "bbb", "ccc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "gg", 0, 3, "First line of the file"]
    , ["B061 G on an all-whitespace last line -> last space", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["aaa", "bbb", "   "][i].length
        , lineText      : (i) => ["aaa", "bbb", "   "][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "G", 2, 2, "Last line of the file"]
    , ["B061 ^ on an all-whitespace current line -> last space", {
        totalLines    : 2, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["  ", "x"][i].length
        , lineText      : (i) => ["  ", "x"][i]
        , viewportTop   : 0, viewportBottom: 1
    }, "^", 0, 1, "At the first non-blank character"]
    , ["B061 + onto an all-whitespace line -> last space", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["x", "    ", "y"][i].length
        , lineText      : (i) => ["x", "    ", "y"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "+", 1, 3, "Down 1 line, first non-blank"]
    , ["B061 gg on an EMPTY first line -> char 0 (not past end)", {
        totalLines    : 2, currentLine   : 1, currentChar   : 0
        , lineLength    : (i) => ["", "x"][i].length
        , lineText      : (i) => ["", "x"][i]
        , viewportTop   : 0, viewportBottom: 1
    }, "gg", 0, 0, "First line of the file"]
    , ["B061 gg on a line WITH text is unchanged (first non-blank)", {
        totalLines    : 2, currentLine   : 1, currentChar   : 0
        , lineLength    : (i) => ["  code", "x"][i].length
        , lineText      : (i) => ["  code", "x"][i]
        , viewportTop   : 0, viewportBottom: 1
    }, "gg", 0, 2, "First line of the file"]
    // B065: N% rounds UP (ceil), matching Vim (lines*count+99)/100. 24% of 10 lines -> line 3.
    , ["B065 24% ceil -> line 3", {
        totalLines    : 10, currentLine   : 0, currentChar   : 0
        , lineLength    : () => 1, lineText      : () => "a"
        , viewportTop   : 0, viewportBottom: 9
    }, "24%", 2, 0, "At 24% of the file (line 3)"]
    // B064: N% lands on the first non-blank of the target line (Vim beginline BL_SOL|BL_FIX).
    , ["B064 20% first non-blank (indented target)", {
        totalLines    : 10, currentLine   : 0, currentChar   : 0
        , lineLength    : (i) => ["aaa", "   bbb", "c", "d", "e", "f", "g", "h", "i", "j"][i].length
        , lineText      : (i) => ["aaa", "   bbb", "c", "d", "e", "f", "g", "h", "i", "j"][i]
        , viewportTop   : 0, viewportBottom: 9
    }, "20%", 1, 3, "At 20% of the file (line 2)"]
    // B066: gM uses floor (Vim i/2), not round. "hello" (len 5) -> floor(2.5) = col 2.
    , ["B066 gM floor -> char 3", {
        totalLines    : 1, currentLine   : 0, currentChar   : 0
        , lineLength    : () => "hello".length, lineText      : () => "hello"
        , viewportTop   : 0, viewportBottom: 0
    }, "gM", 0, 2, "At the middle of the line (char 3)"]
    // B064: section motion lands on the first non-blank of the target line (Vim beginline BL_WHITE|BL_FIX).
    , ["B064 ]] first non-blank on an indented fallback line", {
        totalLines    : 3, currentLine   : 0, currentChar   : 1
        , lineLength    : (i) => ["abc", "def", "   ghi"][i].length
        , lineText      : (i) => ["abc", "def", "   ghi"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "]]", 2, 3, "Forward to the next '{' at the line start"]
    // B067: [[ from the last line (cursor char > 0, no brace) clamps to line 1, not the current line.
    , ["B067 [[ from last line char>0 -> line 1", {
        totalLines    : 3, currentLine   : 2, currentChar   : 2
        , lineLength    : (i) => ["aaa", "bbb", "ccc"][i].length
        , lineText      : (i) => ["aaa", "bbb", "ccc"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "[[", 0, 0, "Backward to the previous '{' at the line start"]
    // B075: [[ with the cursor ON a section-boundary line at col > 0 moves to the PREVIOUS section,
    // not the cursor's own line (Vim findpar advances at least one line before matching).
    , ["B075 [[ from a brace line at col>0 -> previous section", {
        totalLines    : 4, currentLine   : 2, currentChar   : 3
        , lineLength    : (i) => ["{ first", "  body", "{ second", "  more"][i].length
        , lineText      : (i) => ["{ first", "  body", "{ second", "  more"][i]
        , viewportTop   : 0, viewportBottom: 3
    }, "[[", 0, 0, "Backward to the previous '{' at the line start"]
    // B076: cw on a non-blank acts like ce (word END, inclusive), not dw (word-start, exclusive).
    , ["B076 cw on non-blank -> ce (word end)", {
        totalLines    : 1, currentLine   : 0, currentChar   : 0
        , lineLength    : () => "foo bar".length, lineText      : () => "foo bar"
        , viewportTop   : 0, viewportBottom: 0
    }, "cw", 0, 2, "Forward to the end of the word"]
    // B076 edge: cw on the LAST char of a word changes only that char (Vim end_word stop), not ce.
    , ["B076 cw on a word-end char changes one char", {
        totalLines    : 1, currentLine   : 0, currentChar   : 1
        , lineLength    : () => "ab cd".length, lineText      : () => "ab cd"
        , viewportTop   : 0, viewportBottom: 0
    }, "cw", 0, 1, "Change one character"]
    // B080: a hjkl chain clamps at each edge PER MOTION, so an overshoot then reverse does not
    // cancel. B107: the NOTE follows the caret, so these read as the real move -- they used to say
    // "The current position" while the case names ("lands mid-buffer", "advances") said otherwise.
    , ["B080/B107 5j5k from near the bottom lands mid-buffer", {
        totalLines    : 10, currentLine   : 8, currentChar   : 0
        , lineLength    : () => 1, lineText      : () => "a"
        , viewportTop   : 0, viewportBottom: 9
    }, "5j5k", 4, 0, "Up 4 lines (9 - 4)"]
    , ["B080/B107 1k1j from the top advances (k clamps first)", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : () => 1, lineText      : () => "x"
        , viewportTop   : 0, viewportBottom: 2
    }, "1k1j", 1, 0, "Down 1 line (1 + 1)"]
    // B107: a chain whose requested net is zero but which travelled -- the note must say so.
    , ["B107 5l5h parks on the line end then walks back", {
        totalLines    : 3, currentLine   : 1, currentChar   : 5
        , lineLength    : () => 8, lineText      : () => "abcdefgh"
        , viewportTop   : 0, viewportBottom: 2
    }, "5l5h", 1, 2, "Left 3 chars (6 - 3)"]
    , ["B107 9l9h ends ON the line start, so it names the edge", {
        totalLines    : 3, currentLine   : 1, currentChar   : 5
        , lineLength    : () => 8, lineText      : () => "abcdefgh"
        , viewportTop   : 0, viewportBottom: 2
    }, "9l9h", 1, 0, "Char 1 (line start)"]   // standalone clause is capitalised (B022)
    , ["B107 a j-only chain never invents a column clause", {
        totalLines    : 3, currentLine   : 0, currentChar   : 4
        , lineLength    : (i) => [8, 0, 8][i], lineText      : (i) => ["abcdefgh", "", "abcdefgh"][i]
        , viewportTop   : 0, viewportBottom: 2
    }, "1j", 1, 0, "Down 1 line (1 + 1)"]
    // B079: a count before the operator (2dd) == the count after it; 2dd deletes 2 lines (== dj).
    , ["B079 2dd resolves like dj (2 lines, linewise)", {
        totalLines    : 3, currentLine   : 0, currentChar   : 0
        , lineLength    : () => 1, lineText      : () => "x"
        , viewportTop   : 0, viewportBottom: 2
    }, "2dd", 1, 0, "Down 1 line (1 + 1)"]
];

// B108 text objects. A 6-line document with a quoted string, a brace block, a bracket pair, a
// blank line and a nested tag, so every object family has something real to resolve against.
//   0 "function f(a, b) {"       3 "}"
//   1 '    const s = "hi there";' 4 ""
//   2 "    return [a, b];"        5 "<div><p>text</p></div>"
const OBJ_LINES = [
    "function f(a, b) {"
    , "    const s = \"hi there\";"
    , "    return [a, b];"
    , "}"
    , ""
    , "<div><p>text</p></div>"
];
// caret on the "i" of "hi" (line 2, col 17 in 1-based terms)
const OBJ_CTX = {
    totalLines    : 6, currentLine   : 1, currentChar   : 16
    , lineLength    : (i) => OBJ_LINES[i].length, lineText      : (i) => OBJ_LINES[i]
    , viewportTop   : 0, viewportBottom: 5
};
// caret on the "e" of "text", inside <p> inside <div>
const TAG_CTX = { ...OBJ_CTX, currentLine: 5, currentChar: 9 };
// caret on the "b" of the [a, b] bracket pair
const BRACKET_CTX = { ...OBJ_CTX, currentLine: 2, currentChar: 15 };

// [ description, ctx, value, startLine, startChar, endLine, endChar, detail ]
// An inclusive range: end is the LAST char of the object (applyRange bumps it for vscode.Range).
const TEXTOBJ_CASES = [
    // word / WORD -- "hi" sits inside a quoted string, so WORD swallows the opening quote
    ["B108 iw = the word under the caret", OBJ_CTX, "iw", 1, 15, 1, 16, "Inner word"]
    , ["B108 aw adds the trailing space", OBJ_CTX, "aw", 1, 15, 1, 17, "A word"]
    , ["B108 iW takes the quote too", OBJ_CTX, "iW", 1, 14, 1, 16, "Inner WORD"]
    , ["B108 aW adds the trailing space", OBJ_CTX, "aW", 1, 14, 1, 17, "A WORD"]
    , ["B108 2iw spans two runs (word + space)", OBJ_CTX, "2iw", 1, 15, 1, 17, "Inner word"]
    // quotes
    , ["B108 i\" excludes the quotes", OBJ_CTX, "i\"", 1, 15, 1, 22, "Inner quoted string"]
    // no trailing whitespace after the closing quote (a ";" follows), so motion.txt:695-696 sends
    // `a"` to the LEADING whitespace instead -- start is the space at 13, not the quote at 14
    , ["B108 a\" includes the quotes + leading ws", OBJ_CTX, "a\"", 1, 13, 1, 23, "A quoted string"]
    , ["B108 2i\" includes the quotes (count 2)", OBJ_CTX, "2i\"", 1, 14, 1, 23, "Inner quoted string"]
    // brace block: { on line 1 col 18, } on line 4 col 1
    , ["B108 i{ is the block interior", OBJ_CTX, "i{", 1, 0, 2, 17, "Inner Block"]
    , ["B108 a{ includes both braces", OBJ_CTX, "a{", 0, 17, 3, 0, "A Block"]
    , ["B108 iB is the i{ synonym", OBJ_CTX, "iB", 1, 0, 2, 17, "Inner Block"]
    , ["B108 a} is the a{ synonym", OBJ_CTX, "a}", 0, 17, 3, 0, "A Block"]
    // bracket pair on line 3: [a, b]
    , ["B108 i[ interior", BRACKET_CTX, "i[", 2, 12, 2, 15, "Inner [] block"]
    , ["B108 a] includes the brackets", BRACKET_CTX, "a]", 2, 11, 2, 16, "A [] block"]
    // paragraph: lines 1-4 non-blank, line 5 blank
    , ["B108 ip stops before the blank line", OBJ_CTX, "ip", 0, 0, 3, 0, "Inner paragraph"]
    , ["B108 ap takes the blank line too", OBJ_CTX, "ap", 0, 0, 4, 0, "A paragraph"]
    // tag blocks, including the nesting count
    , ["B108 it is the tag contents", TAG_CTX, "it", 5, 8, 5, 11, "Inner tag block"]
    , ["B108 at includes both tags", TAG_CTX, "at", 5, 5, 5, 15, "A tag block"]
    , ["B108 2at steps out one nesting level", TAG_CTX, "2at", 5, 0, 5, 21, "A tag block"]
    , ["B108 2it is the outer tag's contents", TAG_CTX, "2it", 5, 5, 5, 15, "Inner tag block"]
    // an operator takes the object as its range
    , ["B108 di\" deletes the string body", OBJ_CTX, "di\"", 1, 15, 1, 22, "Inner quoted string"]
    , ["B108 ya{ copies the whole block", OBJ_CTX, "ya{", 0, 17, 3, 0, "A Block"]
];

// B108-review: every defect the three independent reviewers confirmed, pinned so it cannot return.
// Each cites the vendored motion.txt / pattern.txt line that decides the behavior.
const WS_LINES  = ["foo   bar"];
const WS_CTX    = { totalLines    : 1, currentLine   : 0, currentChar   : 4
    , lineLength    : () => WS_LINES[0].length, lineText      : () => WS_LINES[0]
    , viewportTop   : 0, viewportBottom: 0 };
const PARA_LINES = ["aaa", "   ", "bbb"];         // middle line is BLANK (spaces only)
const PARA_CTX   = { totalLines    : 3, currentLine   : 0, currentChar   : 0
    , lineLength    : (i) => PARA_LINES[i].length, lineText      : (i) => PARA_LINES[i]
    , viewportTop   : 0, viewportBottom: 2 };
const MULTIPARA  = ["a1", "a2", "", "b1", "b2", "", "c1"];
const MULTI_CTX  = { totalLines    : 7, currentLine   : 0, currentChar   : 0
    , lineLength    : (i) => MULTIPARA[i].length, lineText      : (i) => MULTIPARA[i]
    , viewportTop   : 0, viewportBottom: 6 };
const oneLine = (text, char) => ({ totalLines    : 1, currentLine   : 0, currentChar   : char
    , lineLength    : () => text.length, lineText      : () => text
    , viewportTop   : 0, viewportBottom: 0 });

const REVIEW_CASES = [
    // aw starting on whitespace takes the FOLLOWING word too (motion.txt:553, :714-715); the
    // whitespace-is-its-own-object rule at :716-718 is for the INNER commands only
    ["review aw on whitespace takes the word", WS_CTX, "aw", 0, 3, 0, 8, "A word"]
    , ["review iw on whitespace is just the run", WS_CTX, "iw", 0, 3, 0, 5, "Inner word"]
    // a whitespace-only line is a paragraph boundary (motion.txt:591-592, :598-599)
    , ["review ip stops at a spaces-only line", PARA_CTX, "ip", 0, 0, 0, 2, "Inner paragraph"]
    // count on "a" paragraphs must not collapse to count 1 (motion.txt:589)
    , ["review 2ap spans two paragraphs", MULTI_CTX, "2ap", 0, 0, 5, 0, "A paragraph"]
    , ["review ap spans one", MULTI_CTX, "ap", 0, 0, 2, 0, "A paragraph"]
    // i( finds the NEXT block when the caret is not inside one (motion.txt:632-633)
    , ["review i( falls forward to the next block", oneLine("a (b) c", 0), "i(", 0, 3, 0, 3, "Inner block"]
    // quote pairing counts the backslash RUN, so an escaped backslash still closes ('quoteescape')
    , ["review escaped backslash still closes", oneLine("x \"a\\\\\" y", 4), "i\"", 0, 3, 0, 5, "Inner quoted string"]
    // tag matching ignores case (motion.txt:774)
    , ["review tag match ignores case", oneLine("<DIV>x</div>", 5), "it", 0, 5, 0, 5, "Inner tag block"]
    // it on an EMPTY tag block selects the leading tag (motion.txt:772)
    , ["review it on an empty block takes the open tag", oneLine("<a><b></b></a>", 6), "it", 0, 3, 0, 5, "Inner tag block"]
    // an attribute value may contain ">" -- the tag must not end inside the quotes
    , ["review > inside an attribute value", oneLine("<a t=\"x>y\">z</a>", 11), "it", 0, 11, 0, 11, "Inner tag block"]
];

// [ description, ctx, value, label ] -- an object key that resolves to nothing, or is not an object
const TEXTOBJ_MISS_CASES = [
    // a count deeper than the actual nesting FAILS rather than clamping to the outermost block
    ["review 3at with only 2 levels fails", oneLine("<a><b>x</b></a>", 6), "3at"
        , "No tag block around the cursor"]
    ,["B108 ci( with no paren around the caret", OBJ_CTX, "ci(", "No block around the cursor"]
    , ["B108 2i{ with only one nesting level", OBJ_CTX, "2i{", "No Block around the cursor"]
    , ["B108 it outside any tag", OBJ_CTX, "it", "No tag block around the cursor"]
    , ["B108 iq is not a text object -> Invalid", OBJ_CTX, "iq", INVALID]
    // These two asserted Invalid because a bare object PREFIX is not an object. True, but they are
    // also Vim's insert / append commands (index.txt:397, :387), which is what they resolve to now.
    // The object branch is untouched -- `iq` above still rejects, and every `a<obj>` / `i<obj>` in
    // this block still routes to the object grammar, since these patterns match the whole input.
    , ["B112 bare i is Vim insert-before-cursor", OBJ_CTX, "i", "Go to line 2 and char 17."]
    , ["B112 bare a is Vim append-after-cursor", OBJ_CTX, "a", "Go to line 2 and char 18."]
];

// B108 search. Four lines with "alpha" three times (twice as a whole word, once inside
// "alphabet") so wrap-around, direction, count and the whole-word anchor are all observable.
//   0 "alpha beta"   1 "gamma alpha"   2 "delta"   3 "alphabet end"
const SEARCH_LINES = ["alpha beta", "gamma alpha", "delta", "alphabet end"];
// caret on the "a" that starts "alpha" on line 2
const SEARCH_CTX = {
    totalLines    : 4, currentLine   : 1, currentChar   : 6
    , lineLength    : (i) => SEARCH_LINES[i].length, lineText      : (i) => SEARCH_LINES[i]
    , viewportTop   : 0, viewportBottom: 3
};
const REMEMBERED = { ...SEARCH_CTX
    , lastSearch: { pattern: "alpha", backward: false, wholeWord: false } };

// [ description, ctx, value, line, character, detail ]
const SEARCH_CASES = [
    ["B108 /alpha finds the next match", SEARCH_CTX, "/alpha", 3, 0, "Search forward for \"alpha\""]
    , ["B108 ?alpha searches backward", SEARCH_CTX, "?alpha", 0, 0, "Search backward for \"alpha\""]
    , ["B108 2/alpha wraps past the last match", SEARCH_CTX, "2/alpha", 0, 0, "Search forward for \"alpha\""]
    , ["B108 /a.p.a treats the pattern as a regex", SEARCH_CTX, "/a.p.a", 3, 0, "Search forward for \"a.p.a\""]
    , ["B108 * is the whole word under the caret", SEARCH_CTX, "*", 0, 0, "Next whole word \"alpha\""]
    , ["B108 # searches that word backward", SEARCH_CTX, "#", 0, 0, "Previous whole word \"alpha\""]
    , ["B108 g* drops the word boundary (hits alphabet)", SEARCH_CTX, "g*", 3, 0, "Next match \"alpha\""]
    , ["B108 2* wraps back to the caret's own match", SEARCH_CTX, "2*", 1, 6, "Next whole word \"alpha\""]
    , ["B108 n repeats the remembered pattern", REMEMBERED, "n", 3, 0, "Next match of \"alpha\""]
    , ["B108 N reverses the remembered direction", REMEMBERED, "N", 0, 0, "Previous match of \"alpha\""]
    , ["B108 d/alpha takes the search as its motion", SEARCH_CTX, "d/alpha", 3, 0, "Search forward for \"alpha\""]
];

// [ description, ctx, value, label ]
const SEARCH_MISS_CASES = [
    ["B108 a missing pattern reports itself", SEARCH_CTX, "/nope", "Pattern not found: nope"]
    , ["B108 a bare / pends for the pattern", SEARCH_CTX, "/", "Type the pattern to search forward."]
    , ["B108 a bare ? pends for the pattern", SEARCH_CTX, "?", "Type the pattern to search backward."]
    , ["B108 n with no previous search says so", SEARCH_CTX, "n", "No previous search pattern."]
    , ["B108 N with no previous search says so", SEARCH_CTX, "N", "No previous search pattern."]
];

// [ description, ctx, value, line, character, detail ] -- search-side review fixes
const REVIEW_SEARCH_CASES = [
    // normalizeSpec must keep a search pattern VERBATIM: dropSpaces used to turn "/a b" into "/ab"
    ["review a pattern keeps its spaces", { ...SEARCH_CTX, currentLine: 0, currentChar: 0 }
        , "/alpha b", 0, 0, "Search forward for \"alpha b\""]
    // the note must read the ACTUAL direction: after "?pat", n repeats BACKWARD
    , ["review n after ?pat reads Previous", { ...SEARCH_CTX, currentLine: 1, currentChar: 0
        , lastSearch : { pattern: "alpha", backward: true, wholeWord: false } }
    , "n", 0, 0, "Previous match of \"alpha\""]
    , ["review N after ?pat reads Next", { ...SEARCH_CTX, currentLine: 1, currentChar: 0
        , lastSearch : { pattern: "alpha", backward: true, wholeWord: false } }
    // N flips a backward search to forward; from line 2 col 1 the next match is the SAME line's
    // "alpha" at col 7, not the one further down
    , "N", 1, 6, "Next match of \"alpha\""]
    // a repeat must KEEP the whole-word anchor a "*" established (pattern.txt:81-82)
    , ["review n keeps the * whole-word anchor", { ...SEARCH_CTX, currentLine: 1, currentChar: 6
        , lastSearch : { pattern: "alpha", backward: false, wholeWord: true } }
    , "n", 0, 0, "Next match of \"alpha\""]
    // rules 3-4: no keyword at or after the caret -> fall back to the non-blank run (pattern.txt:76-79)
    , ["review * falls back to a non-blank run", oneLine("a + +", 2), "*", 0, 4, "Next whole word \"+\""]
    // rule 2 still beats rule 3 -- a keyword LATER on the line wins over punctuation under the caret
    , ["review * prefers a later keyword (rule 2)", oneLine("a + b", 2), "*", 0, 4, "Next whole word \"b\""]
];

// B110: "," repeats the latest f/F/t/T in the OPPOSITE direction (motion.txt:305-306). Caret sits
// in the MIDDLE of a line with matches on both sides, unlike the shared LINES fixture (caret near
// the start), so a reversed search always has something to find.
const COMMA_LINE = "a-a-a-a-a";
const COMMA_CTX = {
    totalLines    : 1, currentLine   : 0, currentChar   : 4
    , lineLength    : () => COMMA_LINE.length, lineText      : () => COMMA_LINE
    , viewportTop   : 0, viewportBottom: 0
};

// [ description, ctx, value, line, character, detail ]
const FIND_REPEAT_CASES = [
    ["B110 , reverses a forward f to backward", { ...COMMA_CTX, lastFind: { motion: "f", char: "a" } }
        , ",", 0, 2, "Backward to \"a\""]
    , ["B110 2, repeats the reversal by count", { ...COMMA_CTX, lastFind: { motion: "f", char: "a" } }
        , "2,", 0, 0, "Backward to \"a\" x2"]
    , ["B110 , reverses a backward F to forward", { ...COMMA_CTX, lastFind: { motion: "F", char: "a" } }
        , ",", 0, 6, "Forward to \"a\""]
    // t <-> T swap keeps the till-ness, only the direction flips
    , ["B110 , reverses t to T (till-ness kept)", { ...COMMA_CTX, lastFind: { motion: "t", char: "a" } }
        , ",", 0, 3, "Backward till after \"a\""]
    , ["B110 , reverses T to t (till-ness kept)", { ...COMMA_CTX, lastFind: { motion: "T", char: "a" } }
        , ",", 0, 5, "Forward till before \"a\""]
    // A repeated TILL sits one column from its consumed match; Vim's default 'cpoptions' (no ';',
    // options.txt:2519) makes the repeat "skip over it and jump to the following occurrence"
    // (options.txt:2805-2810) -- without the skip these two stalled on the same column forever.
    , ["B110 review: , after t skips the adjacent match", {
        totalLines    : 1, currentLine   : 0, currentChar   : 3
        , lineLength    : () => 5, lineText      : () => "a.a.b"
        , viewportTop   : 0, viewportBottom: 0, lastFind      : { motion: "t", char: "a" }
    }, ",", 0, 1, "Backward till after \"a\""]
    , ["B110 review: , after T skips the adjacent match", {
        totalLines    : 1, currentLine   : 0, currentChar   : 1
        , lineLength    : () => 5, lineText      : () => "x.a.a"
        , viewportTop   : 0, viewportBottom: 0, lastFind      : { motion: "T", char: "a" }
    }, ",", 0, 3, "Forward till before \"a\""]
];

// [ description, ctx, value, label ]
const FIND_REPEAT_MISS_CASES = [
    ["B110 , with no previous find says so", COMMA_CTX, ",", "No previous find character to repeat."]
    // the reversed direction genuinely has nothing: "fe" on " a cdefg" (char 2) finds "e" forward;
    // reversed is F, and there is no "e" before the caret on this line
    , ["B110 , reports a miss like f/F/t/T do", { ...ctx, lastFind: { motion: "f", char: "e" } }
        , ",", NF("e", "before")]
    // the adjacent-skip (options.txt:2805-2810) consumes the ONLY remaining match -> a clean miss,
    // not an eternal stall on the same column
    , ["B110 review: , till-skip with nothing left is a miss", {
        totalLines    : 1, currentLine   : 0, currentChar   : 1
        , lineLength    : () => 2, lineText      : () => "ay"
        , viewportTop   : 0, viewportBottom: 0, lastFind      : { motion: "t", char: "a" }
    }, ",", NF("a", "before")]
];

// Mode gating (B097). Each case: the same input, the internal mode, and whether it
// should stay VALID or become "Invalid input". "no-vim" keeps ONLY improvement-origin commands;
// "default" keeps everything. The origin split is the contract in docs/logic-classification.md.
// [ description, value, mode, expectValid ]
const MODE_CASES = [
    // no-vim REJECTS every Vim command (motions, operators, mix, one-shots, ex, bracket)
    ["no-vim rejects a motion (w)", "w", "no-vim", false]
    , ["no-vim rejects gg", "gg", "no-vim", false]
    , ["no-vim rejects operator+motion (dw)", "dw", "no-vim", false]
    , ["no-vim rejects operator+improvement mix (d5)", "d5", "no-vim", false]
    , ["no-vim rejects a percent-mix (y50%+1)", "y50%+1", "no-vim", false]
    , ["no-vim rejects operator+relative mix (c+3)", "c+3", "no-vim", false]
    , ["no-vim rejects operator+range (y1;19)", "y1;19", "no-vim", false]
    , ["no-vim rejects a doubled operator (dd)", "dd", "no-vim", false]
    , ["no-vim rejects a doubled case op (guu)", "guu", "no-vim", false]
    , ["no-vim rejects a one-shot (x)", "x", "no-vim", false]
    , ["no-vim rejects a one-shot (2~)", "2~", "no-vim", false]
    , ["no-vim rejects an ex command (:w)", ":w", "no-vim", false]
    , ["no-vim rejects an ex range (:1,9y)", ":1,9y", "no-vim", false]
    , ["no-vim rejects an ex substitute (:%s/a/b/g)", ":%s/a/b/g", "no-vim", false]
    , ["no-vim rejects an ex move (:1,3m8)", ":1,3m8", "no-vim", false]
    , ["no-vim rejects the bracket motion (%)", "%", "no-vim", false]
    , ["no-vim rejects operator+bracket (d%)", "d%", "no-vim", false]
    , ["no-vim rejects the Vim first-non-blank line (5+)", "5+", "no-vim", false]
    , ["no-vim rejects the v select operator", "vw", "no-vim", false]
    , ["no-vim rejects the V select operator", "V5", "no-vim", false]
    , ["no-vim rejects a fold command (zo)", "zo", "no-vim", false]
    , ["no-vim rejects undo (u)", "u", "no-vim", false]
    , ["no-vim rejects ga (message-only, explicit origin)", "ga", "no-vim", false]
    , ["no-vim rejects an ex range (:1,9y)", ":1,9y", "no-vim", false]
    // no-vim KEEPS the better-goto combos (go-to + go-to-select)
    , ["no-vim keeps a bare line (5)", "5", "no-vim", true]
    , ["no-vim keeps line:col (5:9)", "5:9", "no-vim", true]
    , ["no-vim keeps relative (+5)", "+5", "no-vim", true]
    , ["no-vim keeps percent (50%)", "50%", "no-vim", true]
    , ["no-vim keeps a percent compose (50%+1)", "50%+1", "no-vim", true]
    , ["no-vim keeps base+percent (20+10%)", "20+10%", "no-vim", true]
    , ["no-vim keeps a two-coordinate select (5:5;5:9)", "5:5;5:9", "no-vim", true]
    , ["no-vim keeps the full combo", "10%+2:20%-10;10%-2-1-10%:22+1%-2", "no-vim", true]
    // B110: the WHOLE reason the leading column form moved to "\" instead of reusing Vim's "|" /
    // "l" / "h" -- it must survive no-vim mode exactly like the old leading "," did (origin
    // improvement), while the real Vim "," (repeat-find) must NOT.
    , ["no-vim keeps the backslash column (\\5)", "\\5", "no-vim", true]
    , ["no-vim keeps a signed backslash column (\\+3)", "\\+3", "no-vim", true]
    , ["no-vim keeps a percent backslash column (\\50%)", "\\50%", "no-vim", true]
    , ["no-vim rejects the Vim comma repeat (,)", ",", "no-vim", false]
    // B111: a put is Vim-origin, so no-vim rejects it; the "\" column marker is improvement-origin
    // and survives, including in its MIDDLE position (2\2), which is a plain synonym of 2:2.
    // B112: every delegate is Vim-origin, so no-vim must reject all eight
    , ["no-vim rejects ZZ", "ZZ", "no-vim", false]
    , ["no-vim rejects gt", "gt", "no-vim", false]
    , ["no-vim rejects K", "K", "no-vim", false]
    , ["no-vim rejects go", "go", "no-vim", false]
    , ["no-vim rejects gf", "gf", "no-vim", false]
    , ["no-vim rejects a put (p)", "p", "no-vim", false]
    , ["no-vim rejects a bracket put (]p)", "]p", "no-vim", false]
    , ["no-vim keeps the mid backslash delimiter (2\\2)", "2\\2", "no-vim", true]
    , ["no-vim keeps a mid backslash percent column (5\\50%)", "5\\50%", "no-vim", true]
    // default keeps BOTH halves (a Vim command AND an improvement combo)
    , ["default keeps a Vim motion (w)", "w", "default", true]
    , ["default keeps operator+box mix (d5)", "d5", "default", true]
    , ["default keeps an ex command (:w)", ":w", "default", true]
    , ["default keeps an improvement combo (50%+1)", "50%+1", "default", true]
    , ["default keeps v select", "vw", "default", true]
    , ["default keeps a fold command", "zo", "default", true]
    , ["default keeps ga", "ga", "default", true]
    // an unset mode behaves as default (existing 486 cases rely on this)
    , ["unset mode == default (w valid)", "w", undefined, true]
    // B103 -- a VIM-half PENDING prefix must be gated too: in no-vim it may not show a Vim prompt
    // inviting a completion the mode cannot accept. (Operator pendings were already gated by
    // `operator !== "go"`; these are the go+none ones that leaked.)
    , ["no-vim rejects the ex prefix (:)", ":", "no-vim", false]
    , ["no-vim rejects the z prefix", "z", "no-vim", false]
    , ["no-vim rejects a counted z prefix (5z)", "5z", "no-vim", false]
    , ["no-vim rejects the g prefix", "g", "no-vim", false]
    , ["no-vim rejects the f prefix", "f", "no-vim", false]
    , ["no-vim rejects the F prefix", "F", "no-vim", false]
    , ["no-vim rejects the t prefix", "t", "no-vim", false]
    , ["no-vim rejects the T prefix", "T", "no-vim", false]
    , ["no-vim rejects the [ prefix", "[", "no-vim", false]
    , ["no-vim rejects the ] prefix", "]", "no-vim", false]
    , ["no-vim rejects the r prefix", "r", "no-vim", false]
    , ["no-vim rejects a counted r prefix (3r)", "3r", "no-vim", false]
    // ... while the box's OWN pendings must survive Vim being off
    , ["no-vim keeps the column pending (5:)", "5:", "no-vim", true]
    , ["no-vim keeps the percent column pending (50%:)", "50%:", "no-vim", true]
    , ["no-vim keeps the range pending (5;)", "5;", "no-vim", true]
    , ["no-vim keeps the dangling-sign pending (+5+)", "+5+", "no-vim", true]
    // B103 class, 2nd mechanism -- a Vim motion that RAN and found nothing returns a MESSAGE target;
    // the message is tagged at the motion's return site so no-vim rejects it instead of printing a
    // Vim motion's report ("'x' not found ...", "No unmatched '(' ...").
    , ["no-vim rejects a find-char miss (fx)", "fx", "no-vim", false]
    , ["no-vim rejects a backward find-char miss (Fx)", "Fx", "no-vim", false]
    , ["no-vim rejects a till miss (tx)", "tx", "no-vim", false]
    , ["no-vim rejects a backward till miss (Tx)", "Tx", "no-vim", false]
    , ["no-vim rejects a counted find-char miss (2fx)", "2fx", "no-vim", false]
    , ["no-vim rejects an unmatched-paren report ([()", "[(", "no-vim", false]
    , ["no-vim rejects an unmatched-paren report (])", "])", "no-vim", false]
    , ["no-vim rejects an unmatched-brace report ([{)", "[{", "no-vim", false]
    , ["no-vim rejects an unmatched-brace report (]})", "]}", "no-vim", false]
    // B103 class, 3rd mechanism -- the ex GOTO redirects into the plain address grammar, so its
    // target came back tagged IMPROVEMENT; the ex choke point now stamps the whole family Vim.
    , ["no-vim rejects the ex goto (:5)", ":5", "no-vim", false]
    , ["no-vim rejects the ex last-line goto (:$)", ":$", "no-vim", false]
    , ["no-vim rejects a bare ex range (:5,9)", ":5,9", "no-vim", false]
    // ... all three still work with Vim on
    , ["default keeps a find-char miss (fx)", "fx", "default", true]
    , ["default keeps an unmatched-paren report ([()", "[(", "default", true]
    , ["default keeps the ex goto (:5)", ":5", "default", true]
    // B104 -- the new tab / buffer / window ex commands are Vim, so no-vim rejects them all; the
    // ex choke point from B103 covers them without a per-command tag.
    , ["no-vim rejects :wqa", ":wqa", "no-vim", false]
    , ["no-vim rejects :tabnew", ":tabnew", "no-vim", false]
    , ["no-vim rejects :tabc", ":tabc", "no-vim", false]
    , ["no-vim rejects :bn", ":bn", "no-vim", false]
    , ["no-vim rejects :only", ":only", "no-vim", false]
    , ["no-vim rejects :enew", ":enew", "no-vim", false]
    , ["default keeps :wqa", ":wqa", "default", true]
    , ["default keeps :tabnew", ":tabnew", "default", true]
    , ["default keeps :bn", ":bn", "default", true]
    , ["default keeps a bare ex range (:5,9)", ":5,9", "default", true]
    // and default mode still shows every Vim prompt
    , ["default keeps the ex prefix (:)", ":", "default", true]
    , ["default keeps the z prefix", "z", "default", true]
    , ["default keeps the g prefix", "g", "default", true]
    , ["default keeps the f prefix", "f", "default", true]
    , ["default keeps the [ prefix", "[", "default", true]
    , ["default keeps the r prefix", "r", "default", true]
];

// pushHistory(history, value, size) -- the pure dedup/cap core of the command-recall history.
// [ description, inputHistory, value, size, expected ]
const HISTORY_CASES = [
    // B105: history stores the RAW typed command, which no longer carries a prefill colon.
    ["empty -> first entry", [], "5", 10, ["5"]]
    , ["prepend newest first", ["5"], "3", 10, ["3", "5"]]
    , ["drop consecutive duplicate", ["5"], "5", 10, ["5"]]
    , ["non-consecutive duplicate kept", ["3", "5"], "5", 10, ["5", "3", "5"]]
    , ["cap to size", ["a", "b", "c"], "d", 3, ["d", "a", "b"]]
    // B117: 0 is an OFF switch, not a bad value to be floored up to 1
    , ["size 0 remembers nothing", ["a"], "b", 0, []]
    , ["size 0 from empty stays empty", [], "b", 0, []]
    , ["negative size reads as 0", ["a"], "b", -5, []]
];

// trimHistory(history, size) -- applied on every box open, so a LOWERED setting takes effect before
// the next commit instead of leaving the dropped entries reachable with Up (B117).
// [ description, inputHistory, size, expected ]
const TRIM_CASES = [
    ["shrink 10 -> 2 keeps the 2 newest", ["a", "b", "c", "d"], 2, ["a", "b"]]
    , ["0 clears an existing history", ["a", "b", "c"], 0, []]
    , ["a bigger size keeps everything", ["a", "b"], 10, ["a", "b"]]
    , ["an equal size is a no-op", ["a", "b"], 2, ["a", "b"]]
    , ["negative size clears", ["a", "b"], -1, []]
    , ["empty stays empty", [], 5, []]
];

/**
 * Run every case, print a per-case result line, and exit non-zero on any failure.
 *
 * @returns {void}
 */
const main = async () => {
  let passed = 0;
  let failed = 0;
  for (const [description, value, expect, operator, kind, line, character, note] of cases) {
    const result = parseCommand(value, ctx);
    try {
            assert.strictEqual(result.operator, operator, "operator mismatch");
            assert.strictEqual(result.target.kind, kind, "target.kind mismatch");
            if (kind === "position") {
              const top = `${VERB[operator]} line ${line + 1} and char ${character + 1}.`;
                assert.strictEqual(result.label, top, "top label mismatch");
                assert.strictEqual(result.target.line, line, "target.line mismatch");
                assert.strictEqual(result.target.character, character, "target.character mismatch");
                if (note !== undefined) {
                    assert.strictEqual(result.detail, note, "detail/note mismatch");
                }
            } else {
                assert.strictEqual(result.label, expect, "label mismatch");
                if (note !== undefined && note !== null) {
                    assert.strictEqual(result.detail, note, "detail/note mismatch");
                }
            }
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} op=${result.operator} kind=${result.target.kind} label=${JSON.stringify(result.label)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, customCtx, value, line, character, note] of CUSTOM_CTX_CASES) {
    const result = parseCommand(value, customCtx);
    try {
            assert.strictEqual(result.target.line, line, "target.line mismatch");
            assert.strictEqual(result.target.character, character, "target.character mismatch");
            if (note !== undefined) {
                assert.strictEqual(result.detail, note, "detail/note mismatch");
            }
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} line=${result.target.line} character=${result.target.character} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, objCtx, value, sLine, sChar, eLine, eChar, detail] of TEXTOBJ_CASES) {
    const result = parseCommand(value, objCtx);
    try {
            assert.strictEqual(result.target.kind, "range", "target.kind mismatch");
            assert.strictEqual(result.target.inclusive, true, "a text object must be inclusive");
            assert.strictEqual(result.target.start.line, sLine, "start.line mismatch");
            assert.strictEqual(result.target.start.character, sChar, "start.character mismatch");
            assert.strictEqual(result.target.end.line, eLine, "end.line mismatch");
            assert.strictEqual(result.target.end.character, eChar, "end.character mismatch");
            assert.strictEqual(result.detail, detail, "detail mismatch");
            // every text object is a VIM origin -- no-vim must reject it
            assert.strictEqual(parseCommand(value, { ...objCtx, mode: "no-vim" }).label, INVALID
                , "a text object must be gated by no-vim");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} target=${JSON.stringify(result.target)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, objCtx, value, label] of TEXTOBJ_MISS_CASES) {
    const result = parseCommand(value, objCtx);
    try {
            assert.strictEqual(result.label, label, "label mismatch");
            assert.notStrictEqual(result.target.kind, "range", "a miss must not produce a range");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} label=${JSON.stringify(result.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, sCtx, value, line, character, detail] of SEARCH_CASES) {
    const result = parseCommand(value, sCtx);
    try {
            assert.strictEqual(result.target.kind, "position", "target.kind mismatch");
            assert.strictEqual(result.target.line, line, "target.line mismatch");
            assert.strictEqual(result.target.character, character, "target.character mismatch");
            assert.strictEqual(result.detail, detail, "detail mismatch");
            // a resolved search must publish its pattern so the picker can remember it for n / N
            assert.ok(result.target.search && result.target.search.pattern
                , "a resolved search must carry target.search.pattern");
            // every search form is a VIM origin -- no-vim must reject it
            assert.strictEqual(parseCommand(value, { ...sCtx, mode: "no-vim" }).label, INVALID
                , "a search must be gated by no-vim");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} target=${JSON.stringify(result.target)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, objCtx, value, sLine, sChar, eLine, eChar, detail] of REVIEW_CASES) {
    const result = parseCommand(value, objCtx);
    try {
            assert.strictEqual(result.target.kind, "range", "target.kind mismatch");
            assert.strictEqual(result.target.start.line, sLine, "start.line mismatch");
            assert.strictEqual(result.target.start.character, sChar, "start.character mismatch");
            assert.strictEqual(result.target.end.line, eLine, "end.line mismatch");
            assert.strictEqual(result.target.end.character, eChar, "end.character mismatch");
            assert.strictEqual(result.detail, detail, "detail mismatch");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} target=${JSON.stringify(result.target)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, sCtx, value, line, character, detail] of REVIEW_SEARCH_CASES) {
    const result = parseCommand(value, sCtx);
    try {
            assert.strictEqual(result.target.kind, "position", "target.kind mismatch");
            assert.strictEqual(result.target.line, line, "target.line mismatch");
            assert.strictEqual(result.target.character, character, "target.character mismatch");
            assert.strictEqual(result.detail, detail, "detail mismatch");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} target=${JSON.stringify(result.target)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  // ip / ap are LINEWISE: a char range would make `dip` on a blank line delete nothing
  for (const [description, objCtx, value] of [
        ["review ip is linewise", PARA_CTX, "ip"], ["review ap is linewise", MULTI_CTX, "ap"]
    ]) {
    const result = parseCommand(value, objCtx);
    try {
            assert.strictEqual(result.target.linewise, true, "a paragraph object must be linewise");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}: ${error.message}`);
    }
  }
  for (const [description, sCtx, value, label] of SEARCH_MISS_CASES) {
    const result = parseCommand(value, sCtx);
    try {
            assert.strictEqual(result.label, label, "label mismatch");
            assert.strictEqual(result.target.kind, "none", "a miss must not resolve a position");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} label=${JSON.stringify(result.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, fCtx, value, line, character, detail] of FIND_REPEAT_CASES) {
    const result = parseCommand(value, fCtx);
    try {
            assert.strictEqual(result.target.kind, "position", "target.kind mismatch");
            assert.strictEqual(result.target.line, line, "target.line mismatch");
            assert.strictEqual(result.target.character, character, "target.character mismatch");
            assert.strictEqual(result.detail, detail, "detail mismatch");
            // "," must NEVER become the new "latest find" -- only a genuine f/F/t/T does (else a
            // second "," would reverse back toward the start instead of continuing outward).
            assert.strictEqual(result.target.find, undefined
                , "a , repeat must not publish target.find");
            // every find-repeat is a VIM origin -- no-vim must reject it
            assert.strictEqual(parseCommand(value, { ...fCtx, mode: "no-vim" }).label, INVALID
                , "a find repeat must be gated by no-vim");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} target=${JSON.stringify(result.target)} detail=${JSON.stringify(result.detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B112 review: every lookup table is keyed by RAW USER INPUT, so an object literal answered for
  // its own prototype -- typing "toString" parsed as a valid command whose label and commands were
  // both undefined, and Enter threw on `for...of undefined`. The tables are prototype-free now;
  // this guards the whole class rather than the one spelling that was reported.
  for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"
        , "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"
        , ":constructor", ":toString", ":valueOf", "gtoString", "ztoString"]) {
    const result = parseCommand(key, ctx);
    try {
            assert.strictEqual(result.label, INVALID, "a prototype member must not parse");
            assert.strictEqual(result.target.kind, "none", "and must not resolve a target");
            passed++;
            console.log(`  ok   B112 prototype guard: ${JSON.stringify(key)}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL B112 prototype guard: ${JSON.stringify(key)}`);
            console.log(`       label=${JSON.stringify(result.label)}`
                + ` target=${JSON.stringify(result.target)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, fCtx, value, label] of FIND_REPEAT_MISS_CASES) {
    const result = parseCommand(value, fCtx);
    try {
            assert.strictEqual(result.label, label, "label mismatch");
            assert.strictEqual(result.target.kind, "none", "a miss must not resolve a position");
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       input=${JSON.stringify(value)} label=${JSON.stringify(result.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B111: "\" took over BOTH jobs the old "," had. The LEADING form (\5) has no ":" equivalent
  // (":5" already means line 5) and is covered above; the MIDDLE form is a pure synonym, so it is
  // pinned by EQUIVALENCE -- every pair must resolve identically, or the swap silently drifted.
  for (const [withBackslash, withColon] of [
        ["2\\2", "2:2"], ["2\\+3", "2:+3"], ["5\\50%", "5:50%"], ["50%\\3", "50%:3"]
        ,["5+10%\\3", "5+10%:3"], ["d2\\2", "d2:2"], ["2\\2;5\\5", "2:2;5:5"], ["2\\", "2:"]
        // trailing-delimiter pendings beyond the simple "2\" case
        ,["50%\\", "50%:"], ["5+10%\\", "5+10%:"]
        // MIXED spellings inside one range -- the only class that exercises TWO delimiter sites in
        // a single parse, so a half-applied sweep would show up here and nowhere else
        ,["2:2;5\\5", "2:2;5:5"], ["5\\1;9:3", "5:1;9:3"], ["5:1;9\\3", "5:1;9:3"]
        // signed line part, and a clamped pair
        ,["+5\\+2", "+5:+2"], ["99\\99", "99:99"]
    ]) {
    const a = parseCommand(withBackslash, ctx);
    const b = parseCommand(withColon, ctx);
    // no-vim too: both spellings are improvement-origin, so BOTH must survive the gate together
    const aNoVim = parseCommand(withBackslash, { ...ctx, mode: "no-vim" });
    const bNoVim = parseCommand(withColon, { ...ctx, mode: "no-vim" });
    try {
            assert.notStrictEqual(a.label, INVALID, `${withBackslash} must not be Invalid`);
            assert.deepStrictEqual(a.target, b.target, "target mismatch vs the ':' spelling");
            assert.strictEqual(a.label, b.label, "label mismatch vs the ':' spelling");
            assert.strictEqual(a.detail, b.detail, "detail mismatch vs the ':' spelling");
            assert.strictEqual(aNoVim.label, bNoVim.label, "no-vim mismatch vs the ':' spelling");
            passed++;
            console.log(`  ok   B111 "${withBackslash}" == "${withColon}"`);
    } catch (error) {
      failed++;
            console.log(`  FAIL B111 "${withBackslash}" == "${withColon}"`);
            console.log(`       ${JSON.stringify(a.label)} vs ${JSON.stringify(b.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B122/B123/B125: rewrites that must resolve identically to their canonical spelling -- count-1
  // doubled operators, both-side gq/gw counts, and a space between an ex range and `s`.
  for (const [alias, canonical] of [
        ["1dd", "dd"], ["1yy", "yy"], ["1cc", "cc"], ["1gqq", "=="], ["2dd", "dj"]
        ,["2gq3w", "=6w"], ["2gw3j", "=6j"], ["gq3w", "=3w"], [":1,5 s/a/b/g", ":1,5s/a/b/g"]
    ]) {
    const a = parseCommand(alias, ctx);
    const b = parseCommand(canonical, ctx);
    try {
            assert.notStrictEqual(a.label, INVALID, `${alias} must not be Invalid`);
            assert.deepStrictEqual(a.target, b.target, "target mismatch vs the canonical spelling");
            assert.strictEqual(a.label, b.label, "label mismatch vs the canonical spelling");
            passed++;
            console.log(`  ok   review26 "${alias}" == "${canonical}"`);
    } catch (error) {
      failed++;
            console.log(`  FAIL review26 "${alias}" == "${canonical}"`);
            console.log(`       ${JSON.stringify(a.label)} vs ${JSON.stringify(b.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B124-B130 direct pins: emoji find, EOL caret, punctuation-adjacent aw, sentence counts,
  // :s trailing garbage, :>> repeats, {count}u.
  for (const [description, someCtx, value, probe] of [
        ["B124 f-emoji resolves to the emoji", oneLine("x\u{1F600}y", 0), "f\u{1F600}"
            , (r) => r.target.kind === "position" && r.target.character === 1]
        , ["B124 tx before an emoji lands on its start", oneLine("a\u{1F600}x", 0), "tx"
            , (r) => r.target.character === 1]
        , ["B125 :s trailing garbage after flags is Invalid", ctx, ":s/foo/bar/g/oops"
            , (r) => r.label === INVALID]
        , ["B126 :5,9>> is indent x2", ctx, ":5,9>>"
            , (r) => r.target.verb === "indent" && r.target.repeat === 2
                && r.target.top === 4 && r.target.bottom === 8]
        , ["B126 :5,9> carries no repeat", ctx, ":5,9>"
            , (r) => r.target.verb === "indent" && r.target.repeat === undefined]
        , ["B126 :<<< is outdent x3 on the current line", ctx, ":<<<"
            , (r) => r.target.verb === "outdent" && r.target.repeat === 3]
        , ["B127 2u runs two undos", ctx, "2u"
            , (r) => JSON.stringify(r.target.commands) === JSON.stringify(["undo", "undo"])
                && r.label === "Undo the last 2 changes."]
        , ["B127 u still runs one undo", ctx, "u"
            , (r) => JSON.stringify(r.target.commands) === JSON.stringify(["undo"])]
        , ["B128 * with the caret at end of line", oneLine("alpha beta", 10), "*"
            , (r) => r.target.kind === "position" && r.target.character === 6]
        , ["B128 viw with the caret at end of line", oneLine("alpha beta", 10), "viw"
            , (r) => r.target.kind === "range" && r.target.start.character === 6
                && r.target.end.character === 9]
        , ["B129 d2aw over punctuation-adjacent words", oneLine("a.b.c", 0), "d2aw"
            , (r) => r.target.kind === "range" && r.target.end.character === 1]
        , ["B129 d2aw over spaced words takes the space", oneLine("foo bar baz", 0), "d2aw"
            , (r) => r.target.end.character === 7]
        , ["B129 daw unchanged (word + trailing space)", oneLine("foo bar", 0), "daw"
            , (r) => r.target.end.character === 3]
        , ["B130 d2as runs to the end of the buffer", oneLine("One. Two.", 0), "d2as"
            , (r) => r.target.kind === "range" && r.target.end.character === 8]
        , ["B130 das unchanged (first sentence only)", oneLine("One. Two.", 0), "das"
            , (r) => r.target.end.character === 4]
    ]) {
    const result = parseCommand(value, someCtx);
    try {
            assert.ok(probe(result), `probe failed: ${JSON.stringify(result.target)}`);
            passed++;
            console.log(`  ok   ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL ${description}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, value, mode, expectValid] of MODE_CASES) {
    const result = parseCommand(value, { ...ctx, mode });
    try {
      const isValid = result.label !== INVALID;
            assert.strictEqual(isValid, expectValid, `expected ${expectValid ? "valid" : "Invalid"}`);
            passed++;
            console.log(`  ok   mode: ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL mode: ${description}`);
            console.log(`       input=${JSON.stringify(value)} mode=${mode} label=${JSON.stringify(result.label)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B101: in no-vim the Invalid hint must not advertise Vim commands, in default it still does.
  const NO_VIM_DETAIL_CASES = [
        ["no-vim rejects dw -> no Vim suggestion, points at setting", "dw", "no-vim", false, "betterGoto.vim"]
        , ["no-vim malformed -> no Vim suggestion", "zqx", "no-vim", false, null]
        , ["default malformed -> keeps Vim suggestion", "zqx", "default", true, null]
    ];
  for (const [description, value, mode, wantVimSuggestion, needle] of NO_VIM_DETAIL_CASES) {
    const detail = parseCommand(value, { ...ctx, mode }).detail || "";
    try {
            assert.strictEqual(/Vim command \(/.test(detail), wantVimSuggestion, "Vim-suggestion mismatch");
            if (needle) assert.ok(detail.includes(needle), `detail missing ${JSON.stringify(needle)}`);
            passed++;
            console.log(`  ok   detail: ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL detail: ${description}`);
            console.log(`       input=${JSON.stringify(value)} mode=${mode} detail=${JSON.stringify(detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  // B110 review fix: the Invalid hint's own EXAMPLES must themselves still parse -- it used to
  // advertise "42,8" / "±5,-2" (comma AS a delimiter) after "," stopped being one, so the hint
  // told the user to type something the box would then reject. The "Vim command (gg, w, ...)"
  // clause legitimately keeps English list-commas -- only the digit-adjacent delimiter spelling
  // (a comma directly next to a number) is the stale pattern being guarded against here.
  for (const [description, mode] of [["default", "default"], ["no-vim", "no-vim"]]) {
    const detail = parseCommand("zqx", { ...ctx, mode }).detail || "";
    try {
            assert.ok(!/\d,|,-?\d/.test(detail)
                , `Invalid-hint detail still advertises a comma-delimiter example: ${JSON.stringify(detail)}`);
            passed++;
            console.log(`  ok   B110 Invalid hint has no stale comma example (${description})`);
    } catch (error) {
      failed++;
            console.log(`  FAIL B110 Invalid hint has no stale comma example (${description})`);
            console.log(`       detail=${JSON.stringify(detail)}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, history, value, size, expected] of HISTORY_CASES) {
    try {
            assert.deepStrictEqual(pushHistory(history, value, size), expected, "pushHistory mismatch");
            passed++;
            console.log(`  ok   history: ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL history: ${description}`);
            console.log(`       ${error.message}`);
    }
  }
  for (const [description, history, size, expected] of TRIM_CASES) {
    try {
            assert.deepStrictEqual(trimHistory(history, size), expected, "trimHistory mismatch");
            passed++;
            console.log(`  ok   trim: ${description}`);
    } catch (error) {
      failed++;
            console.log(`  FAIL trim: ${description}`);
            console.log(`       ${error.message}`);
    }
  }
  // B111 APPLY path -- runs applyPaste for real against the fake editor above. Each case asserts
  // the resulting TEXT and the CURSOR LINE; the two defects an independent reviewer found were
  // both cursor-landing bugs with correct text, so asserting text alone would have missed them.
  // [ description, startText, line, char, clipboard, target, wantText, wantLine ]
  const PASTE_APPLY_CASES = [
        ["p linewise inserts below", "a\nb\nc", 0, 0, "X\n", putTarget({}), "a\nX\nb\nc", 1]
        , ["P linewise inserts above", "a\nb\nc", 1, 0, "X\n", putTarget({ after: false })
            , "a\nX\nb\nc", 1]
        // the reviewer's D1: at EOF the pre-edit line count is what the landing must be built from
        , ["p linewise at EOF lands on the FIRST pasted line", "a\nb", 1, 0, "X\nY\n", putTarget({})
            , "a\nb\nX\nY", 2]
        , ["3p repeats the register", "a\nb", 0, 0, "X\n", putTarget({ count: 3 })
            , "a\nX\nX\nX\nb", 1]
        , ["gp linewise lands past the block", "a\nb", 0, 0, "X\nY\n"
            , putTarget({ cursorAfter: true }), "a\nX\nY\nb", 3]
        , ["p charwise inserts after the cursor char", "abc", 0, 0, "Z", putTarget({}), "aZbc", 0]
        , ["P charwise inserts at the cursor", "abc", 0, 1, "Z", putTarget({ after: false })
            , "aZbc", 0]
        , ["p charwise on an empty line", "", 0, 0, "Z", putTarget({}), "Z", 0]
        , ["p charwise at end of line appends", "abc", 0, 2, "Z", putTarget({}), "abcZ", 0]
        // the reviewer's D2: a charwise register may still contain newlines
        , ["p charwise clip with a newline moves the cursor line", "abc", 0, 0, "XY\nZW"
            , putTarget({}), "aXY\nZWbc", 1]
        , ["]p re-indents the block to the current line", "    a\nb", 0, 4, "        X\n"
            , putTarget({ indent: true }), "    a\n    X\nb", 1]
        , ["an empty clipboard is a no-op", "abc", 0, 0, "", putTarget({}), "abc", 0]
    ];
  for (const [description, text, line, ch, clip, target, wantText, wantLine]
    of PASTE_APPLY_CASES) {
        vscodeStub.env.clipboard.__set(clip);
        const editor = fakeEditor(text, line, ch);
        try {
          await applyPaste(editor, target);
            assert.strictEqual(editor.state.text, wantText, "buffer text mismatch");
            assert.strictEqual(editor.selection.active.line, wantLine, "cursor LINE mismatch");
            passed++;
            console.log(`  ok   B111 apply: ${description}`);
        } catch (error) {
          failed++;
            console.log(`  FAIL B111 apply: ${description}`);
            console.log(`       text=${JSON.stringify(editor.state.text)}`
                + ` cursor=${JSON.stringify(editor.selection.active)}`);
            console.log(`       ${error.message}`);
        }
  }
  // B114 APPLY path -- the indent / format / case / fold family. Everything above this block is a
  // PARSE assertion, and a parse assertion structurally cannot see the defect these cases exist
  // for: from B113 until B114 every one of `=aw` / `>ap` / `guaw` / `gUiw` / `gqiw` / `zfaw` /
  // `zfip` selected exactly the right span and then executed NO COMMAND, because the onAccept
  // dispatch tested `target.kind === "range"` before `INDENT_OPS.has(operator)` and applyRange
  // knows only selectLine / delete / change / yank. Label right, target right, 969 assertions
  // green, feature 100% dead. So these cases assert the COMMAND ID that actually ran, plus the
  // selection it ran against -- the two things that separate "selected it" from "acted on it".
  // [ description, operator, target, wantCommands, wantSelection|null, wantText? ]
  const NEWLINE = String.fromCharCode(10);   // kept out of a string escape (shell-mangling guard)
  const OBJ_RANGE = { kind     : "range", origin   : "vim", inclusive: true
        , start    : { line: 4, character: 0 }, end      : { line: 4, character: 5 }, note     : "a word" };
  const LINEWISE_RANGE = { kind     : "range", origin   : "vim", inclusive: true, linewise : true
        , start    : { line: 4, character: 0 }, end      : { line: 6, character: 7 }, note     : "inner paragraph" };
  const POS_TARGET = { kind: "position", origin: "vim", line: 6, character: 0 };
  const APPLY_CASES = [
        // a text-object RANGE must reach the command, not just the selection
        ["format over a word object runs formatSelection", "format", OBJ_RANGE
            , ["editor.action.formatSelection"], { anchor: { line: 4, character: 0 }
                , active: { line: 4, character: 6 } }]
        , ["indent over a word object runs indentLines", "indent", OBJ_RANGE
            , ["editor.action.indentLines"], null]
        , ["outdent over a word object runs outdentLines", "outdent", OBJ_RANGE
            , ["editor.action.outdentLines"], null]
        // zf{motion}: the whole point of B114 -- a fold must actually be created
        , ["fold over a paragraph object runs createFoldingRangeFromSelection"
            , "fold", LINEWISE_RANGE, ["editor.createFoldingRangeFromSelection"]
            // linewise: whole lines, so the selection spans column 0 to the end of the last line
            , { anchor: { line: 4, character: 0 }, active: { line: 6, character: 8 } }]
        , ["fold over a position target runs createFoldingRangeFromSelection"
            , "fold", POS_TARGET, ["editor.createFoldingRangeFromSelection"], null]
        // the case family, blocked by the exact same dispatch order
        , ["lowercase over a word object runs the lowercase command", "lowercase"
            , OBJ_RANGE, ["editor.action.transformToLowercase"], null]
        , ["uppercase over a word object runs the uppercase command", "uppercase"
            , OBJ_RANGE, ["editor.action.transformToUppercase"], null]
        // and the two that have no built-in command rewrite the text themselves, so they must run
        // ZERO commands -- asserting that keeps the branch honest in both directions
        // 7th field: expected buffer text, for the two that rewrite instead of running a command.
        // Line index 4 of the fixture is " a cdefg"; the object range covers chars 0..5 inclusive,
        // so the selection is " a cde" -> swapCase gives " A CDE", rot13 gives " n pqr".
        , ["togglecase rewrites the text itself, running no command", "togglecase"
            , OBJ_RANGE, [], null, " A CDEfg"]
        , ["rot13 rewrites the text itself, running no command", "rot13"
            , OBJ_RANGE, [], null, " n pqrfg"]
    ];
  for (const [description, operator, target, wantCommands, wantSelection, wantText]
    of APPLY_CASES) {
        vscodeStub.commands.__reset();
        const editor = fakeEditor("abcdefgh\nabcdefgh\nabcdefgh\n\n a cdefg\nabcdefgh\n{abcdefg", 4, 2);
        const saved = { active: { line: 4, character: 2 }, anchor: { line: 4, character: 2 } };
        try {
          // applyCommand, NOT applyIndent / applyCase directly: the defect these cases exist for
          // was in the ROUTING, and calling a helper by hand passes whether or not the dispatch
          // ever reaches it. Verified by reverting the arm order -- helper-level cases stayed
          // green, these go red.
          await applyCommand(editor, operator, saved, target);
            assert.deepStrictEqual(vscodeStub.commands.__calls, wantCommands
                , "executed command ids mismatch");
            if (wantSelection) {
                assert.deepStrictEqual(
                    { anchor: editor.selection.anchor, active: editor.selection.active }
                    , wantSelection, "selection the command acted on mismatch");
            }
            if (wantText !== undefined) {
                assert.strictEqual(editor.state.text.split(NEWLINE)[4], wantText
                    , "rewritten line mismatch");
            }
            passed++;
            console.log(`  ok   B114 apply: ${description}`);
        } catch (error) {
          failed++;
            console.log(`  FAIL B114 apply: ${description}`);
            console.log(`       ran=${JSON.stringify(vscodeStub.commands.__calls)}`
                + ` selection=${JSON.stringify(editor.selection)}`);
            console.log(`       ${error.message}`);
        }
  }

  // B114 APPLY GRID -- the same defect swept as a CATEGORY rather than as the cases above.
  // Invariant: an operator that MUTATES must, for every target kind it can receive, either run a
  // command, edit the buffer, or write the clipboard. An operator that only moves the selection
  // has silently done nothing -- which is exactly what the whole indent / format / case / fold
  // family did for range targets from B113 to B114. The named cases above pin the specific
  // commands; this pins the RULE, so a future operator or target kind cannot quietly join the
  // dead set. Calibrated: reverting the applyCommand arm order turns 16 of these red.
  const MUTATING = ["delete", "yank", "change", "indent", "outdent", "format"
        , "lowercase", "uppercase", "togglecase", "rot13", "fold"];
  const GRID_TARGETS = {
        position           : { kind: "position", origin: "vim", line: 6, character: 0 }
        , "position-linewise": { kind     : "position", origin   : "vim", line     : 6, character: 0
            , linewise : true }
        , range: { kind     : "range", origin   : "vim", inclusive: true
            , start    : { line: 4, character: 0 }, end      : { line: 4, character: 5 } }
        , "range-linewise": { kind     : "range", origin   : "vim", inclusive: true, linewise : true
            , start    : { line: 4, character: 0 }, end      : { line: 6, character: 6 } }
        , wholeLine: { kind: "wholeLine" }
    };
  for (const operator of MUTATING) {
    for (const [kindName, target] of Object.entries(GRID_TARGETS)) {
            vscodeStub.commands.__reset();
            const editor = fakeEditor(
                "abcdefgh\nabcdefgh\nabcdefgh\n\n a cdefg\nabcdefgh\n{abcdefg", 4, 2);
            const before = editor.state.text;
            const beforeClip = vscodeStub.env.clipboard.__text;
            const saved = { active: { line: 4, character: 2 }, anchor: { line: 4, character: 2 } };
            try {
              await applyCommand(editor, operator, saved, target);
              const acted = vscodeStub.commands.__calls.length > 0
                    || editor.state.text !== before
                    || vscodeStub.env.clipboard.__text !== beforeClip;
                assert.ok(acted, "ran no command, edited nothing, wrote no clipboard"
                    + " -- selection-only means this operator silently did nothing");
                passed++;
                console.log(`  ok   B114 grid: ${operator} x ${kindName}`);
            } catch (error) {
              failed++;
                console.log(`  FAIL B114 grid: ${operator} x ${kindName}`);
                console.log(`       ${error.message}`);
            }
    }
  }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
};

main();
