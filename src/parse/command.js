/**
 * @file src/parse/command.js
 * @description The top of the parse pipeline: split an input into operator and target, classify its origin, gate it by mode, and build the pending-input guidance.
 * @scope src
 * @updated-at 2026-09-02
 */
"use strict";

const { MODE_DEFAULT, MODE_NO_VIM } = require("../constants/config.js");
const {
  INVALID_DETAIL
  , INVALID_DETAIL_NO_VIM
  , INVALID_LABEL
} = require("../constants/labels.js");
const {
  REGEX_DELIM_END
  , REGEX_FIND_KEY
  , REGEX_LEADING_COUNT
  , REGEX_RANGE_END
  , REGEX_SIGN_END
} = require("../constants/patterns.js");
const {
  ACTION
  , CASE_OPERATORS
  , DOUBLE_OPERATORS
  , OPERATORS
  , RANGE_VERB
  , VERB
} = require("../constants/vim-tables.js");
const { capitalize, charClass, normalizeSpec } = require("../utils/text.js");
const { position } = require("../motion/line.js");
const {
  coordinate
  , labelLinePrompt
  , rangeDetail
  , rangeLabel
  , wholeLineCommand
} = require("./label.js");
const { exCommand } = require("./ex-command.js");
const { standaloneCommand } = require("./one-shot.js");
const { parseTarget } = require("./target.js");
/**
 * A non-empty spec that did not parse may still be a VALID PREFIX the user is mid-typing -- a find
 * awaiting its char, a g- or bracket motion awaiting its second key, a line:col awaiting the
 * column, a range awaiting its second point, or a chain ending in a dangling sign. Return
 * { label, detail } to guide (instead of "Invalid"); null when no keystroke could complete it.
 *
 * @param {string} spec      operator-stripped command body
 * @param {object} ctx
 * @param {string} operator  gates the range guides (only a range-capable operator gets them)
 * @returns {{label: string, detail: string}|null}
 */
const pendingMessage = (spec, ctx, operator) => {
  // ignore a leading count for the motion-prefix checks
  const rest = spec.replace(REGEX_LEADING_COUNT, "");
  // The four prefixes below open VIM-only grammar, so they carry origin "vim": no-vim must reject
  // them instead of inviting a completion that mode cannot accept (B103). The pendings further
  // down (line + delimiter, range second point, dangling sign) are the box's own grammar and stay
  // untagged so they keep working with Vim off.
  if (REGEX_FIND_KEY.test(rest)) {
    return { label : "Type a character to jump to it on this line."
            , detail: "f = onto it, t = before it, F/T = backward", origin: "vim" };
  }
  if (rest === "g") {
    return { label : "Type the next key after g."
            , detail: "gg = top, g_ = line end, gM = line middle, ge = word-end back"
            , origin: "vim" };
  }
  if (rest === "[") {
    return { label : "Type a bracket to jump to its opener."
            , detail: "[( = paren, [{ = brace, [[ = prev '{'", origin: "vim" };
  }
  if (rest === "]") {
    return { label : "Type a bracket to jump to its closer."
            , detail: "]) = paren, ]} = brace, ]] = next '{'", origin: "vim" };
  }
  // line part + trailing delimiter -> awaiting the column. Probe `head<delim>1`: a POSITION
  // means a single line:col with a real column slot; a RANGE means the SECOND endpoint is
  // mid-typing its column. A motion head probes to none -> Invalid, not a column prompt.
  // A trailing "\" is covered by the same test since B111 widened the delimiter -- "\", "5\",
  // "5;\" and "10:9;\" all end in a delimiter now. `\1` completes to a current-line column, but a
  // bare `:` cannot complete (a ":" target head is Invalid), so `d:` must not advertise one; the
  // probe below is what tells those two apart.
  if (REGEX_DELIM_END.test(spec)) {
    const probed = parseTarget(spec + "1", ctx);
    if (probed.kind === "position") {
      return { label : "Type the char to land on."
                , detail: "3 = char 3, +2 = 2 right, 50% = halfway" };
    }
    // a range second endpoint awaiting its column -- only for an operator that can use a range.
    if (probed.kind === "range" && RANGE_VERB[operator]) {
      return { label : "Type the column of the second point."
                , detail: "3 = char 3, +2 = 2 right, 50% = halfway" };
    }
  }
  // first range point + a trailing range separator -> awaiting the second point. Only a range
  // operator gets it, and only if COMPLETING it yields a valid RANGE: a motion left point (`gg;`,
  // `w;`) probes to none -> Invalid, not a range prompt (a motion cannot be a range endpoint).
  if (REGEX_RANGE_END.test(spec) && RANGE_VERB[operator]
        && parseTarget(spec + "1", ctx).kind === "range") {
    return { label : "Type the second point of the range."
            , detail: "9 = line 9, 5:9 = line 5 char 9, +2 = 2 lines down" };
  }
  // a dangling sign -> awaiting its number, but only if COMPLETING it with a digit yields a valid
  // target: a position, or a range for a range operator. A base that cannot take a numeric offset
  // (a motion: `1j+`, `w+`) completes to none -> Invalid, not a "type a number" prompt -- guide
  // only toward input that can complete validly (same gate as the delimiter branch).
  if (REGEX_SIGN_END.test(spec)) {
    const completed = parseTarget(spec + "1", ctx);
    if (completed.kind === "position"
            || (completed.kind === "range" && RANGE_VERB[operator])) {
      return { label : "Type the number after the +/-."
                , detail: "+5 = 5 down/right, -3 = 3 up/left" };
    }
  }
  return null;
};

/**
 * Parse the full command box value into { operator, target, label }. Pure / unit-testable.
 * Operator detection is a cascade (first match wins): "gX" case op, then doubled "XX" whole-line,
 * then single-char op, then none (plain motion). Order keeps "gg" a motion and "dd" a line op.
 *
 * @param {string} value
 * @param {object} ctx
 * @returns {{ operator: string, target: object, label: string }}
 */
const parseCommandCore = (value, ctx) => {
  // The box does NOT prefill anything (B105), so the value is exactly what the user typed and ONE
  // leading ":" is Vim's ex prefix -- `w` is the word motion, `:w` saves, like Vim. Exactly one
  // colon: `::w` was an artifact of the old prefill and is now Invalid (user directive). The ex
  // goto forms still redirect into the plain goto grammar.
  // NOTE: the pre-B105 code collapsed repeated leading colons and cited cmdline.txt:711-714 for
  // it, but that passage documents a colon BETWEEN the range and the command (`:1,$:s/pat/str`),
  // which is a different form -- and one this box still rejects. Recorded as a separate gap in
  // features/8-ex-commands.md rather than silently carried over.
  const body    = value;
  const exMatch = body.match(/^\s*:([\s\S]*)$/);
  if (exMatch) {
    // the RAW ex body -- exCommand drops spaces itself, except inside an :s pattern.
    const ex = exCommand(exMatch[1], ctx);
    // EVERY ex form is Vim (logic-classification.md) -- including the ex goto (`::5`, `::$`),
    // which redirects back into the plain address grammar and would otherwise come back tagged
    // IMPROVEMENT. Stamping both paths here gates the whole family at ONE choke point, so a new
    // ex form cannot leak into no-vim by resolving through a non-Vim branch.
    // The redirect body carries NO colon (B105): a leading ":" now means ex, so re-entering with
    // one would match this same branch forever. `ex.redirect` is only ever a digit string or
    // "G", both of which parse as plain goto grammar.
    return ex.redirect
      ? { ...parseCommandCore(ex.redirect, ctx), origin: "vim" }
      : { ...ex, origin: "vim" };
  }
  const raw0 = normalizeSpec(body);
  // A count BEFORE the operator (2dd, 3yw, 2dj) multiplies the operator+motion, exactly like the
  // count after it (Vim). Fold it in: N<op><op> == <op> over N lines == <op>(N-1)j; otherwise the
  // count moves into the motion (2dj -> d2j).
  let raw = raw0;
  // Uppercase one-shot aliases (Vim): [count]D = d[count]$ (delete to EOL and count-1 more
  // lines, change.txt:53), [count]C = c[count]$ (:199), [count]Y = [count]yy (:1074). Rewrite
  // before everything else so they reuse the tested operator+motion paths, count included.
  const alias = raw.match(/^([1-9]\d*)?([DCY])$/);
  if (alias) {
    const count = alias[1] || "";
    raw = alias[2] === "Y" ? `${count}yy` : `${alias[2] === "D" ? "d" : "c"}${count}$`;
  }
  // Same rewrite for the two substitute aliases (B112). Vim states both as synonyms outright:
  // `S` is "delete N lines and start insert; synonym for cc" (index.txt:363-364) and `s` is
  // "delete N characters and start insert" == `c[count]l` (:425-426). The "start insert" half
  // costs nothing here -- VS Code has no Normal mode to leave -- so each is exactly its operator
  // form, and rewriting means they inherit the tested c-operator paths including the count.
  const substitute = raw.match(/^([1-9]\d*)?([sS])$/);
  if (substitute) {
    const count = substitute[1] || "";
    raw = substitute[2] === "S" ? `${count}cc` : `c${count}l`;
  }
  // `gq{motion}` / `gw{motion}` format the motion's text (index.txt:801, :807). Vim distinguishes
  // them from `=` -- `gq` REFLOWS to 'textwidth', `=` re-indents -- and distinguishes gq from gw
  // only by where the cursor ends up. VS Code has one formatting primitive, formatSelection, and
  // it is language-aware re-formatting, so all three collapse onto the `=` operator here. That is
  // a real divergence (no reflow-to-column exists to call) and it is recorded in vim-coverage.md
  // rather than papered over. Rewriting reuses the tested `=` paths, count and doubled form
  // included: `gqq` / `gqgq` / `gww` / `gwgw` are the whole-line
  // spellings (change.txt:1476-1477, :1490-1491), which is `==`.
  const format = raw.match(/^([1-9]\d*)?g([qw])(.*)$/);
  if (format) {
    const count  = format[1] || "";
    const rest   = format[3];
    const doubled = rest === format[2] || rest === `g${format[2]}`;   // gqq / gqgq / gww / gwgw
    // With no motion typed yet the count must stay ON the operator. Emitting `=${count}` would
    // hand the count to the TARGET instead, and `=2` is a valid command here ("format to line
    // 2"), so `2gq` silently resolved while `2=` / `2d` / `2gu` all pend as they should.
    const restCount = rest.match(/^([1-9]\d*)(\D.*)$/); // both-side counts multiply (B123)
    raw = rest === "" ? `${count}=`
      : doubled ? `${count}==`
        : count === "" ? `=${rest}`
          : restCount
            ? "=" + String(parseInt(count, 10) * parseInt(restCount[1], 10)) + restCount[2]
            : /^[1-9]\d*$/.test(rest) ? "=" + String(parseInt(count, 10) * parseInt(rest, 10))
              : `=${count}${rest}`;
  }
  // Self-contained one-shot commands (x / X / J / ~ / r{char} / z scrolls) have no target.
  const standalone = standaloneCommand(raw, ctx);
  if (standalone) return standalone;
  const preCount = raw.match(/^([1-9]\d*)(.)(.*)$/);
  if (preCount && OPERATORS[preCount[2]]) {
    const count = parseInt(preCount[1], 10);
    const op    = preCount[2];
    const rest  = preCount[3];
    if (rest === op) {
      // count 1 keeps the whole-line form -- `1dd` is one line, like the preCountG arm (B122)
      const down = count - 1;
      raw = down === 0 ? op + op : op + (down > 1 ? String(down) : "") + "j";
    } else if (rest !== "") {
      // a count on BOTH sides multiplies (motion.txt:63-65: "2d3w" deletes SIX words). The
      // motion-count split requires a NON-DIGIT suffix -- a pure-number rest is a line
      // address whose count multiplies whole (2d21 == d42, like Vim's 2d21G), never split.
      const restCount = rest.match(/^([1-9]\d*)(\D.*)$/);
      raw = restCount ? op + String(count * parseInt(restCount[1], 10)) + restCount[2]
        : /^[1-9]\d*$/.test(rest) ? op + String(count * parseInt(rest, 10))
          : op + preCount[1] + rest;
    } else {
      raw = op; // a count with no motion yet -- guide for the target, don't flash Invalid
    }
  }
  // The same fold for a count before a g-case operator: 2guw == gu2w (motion-count-multiplied,
  // motion.txt:63-65), 2guu / 2gugu == gu over 2 lines (operator-doubled, motion.txt:66-69).
  const preCountG = raw.match(/^([1-9]\d*)g([uU~?])(.*)$/);
  if (preCountG) {
    const count = parseInt(preCountG[1], 10);
    const key   = preCountG[2];
    const rest  = preCountG[3];
    if (rest === key || rest === "g" + key) {
      const down = count - 1;
      raw = down === 0 ? "g" + key + key : "g" + key + (down > 1 ? String(down) : "") + "j";
    } else if (rest === "") {
      raw = "g" + key; // count typed, motion pending -- guide, don't flash Invalid
    } else {
      // a count on BOTH sides multiplies here too (motion.txt:63-65); same non-digit-suffix
      // split + pure-number multiply as the single-char branch above.
      const restCount = rest.match(/^([1-9]\d*)(\D.*)$/);
      raw = restCount
        ? "g" + key + String(count * parseInt(restCount[1], 10)) + restCount[2]
        : /^[1-9]\d*$/.test(rest) ? "g" + key + String(count * parseInt(rest, 10))
          : "g" + key + preCountG[1] + rest;
    }
  }
  // A leading count multiplies into zf{motion}'s own count (motion.txt:63-65's generic rule).
  // No doubled/whole-line form exists for zf (fold.txt has no "zfzf"), so only multiply and the
  // motion-still-pending guide apply -- the same two arms as preCountG, minus its doubled arm.
  const preCountZF = raw.match(/^([1-9]\d*)zf(.*)$/);
  if (preCountZF) {
    const count = parseInt(preCountZF[1], 10);
    const rest  = preCountZF[2];
    if (rest === "") {
      raw = "zf"; // count typed, motion pending -- guide, don't flash Invalid
    } else {
      const restCount = rest.match(/^([1-9]\d*)(\D.*)$/);
      raw = restCount ? "zf" + String(count * parseInt(restCount[1], 10)) + restCount[2]
        : /^[1-9]\d*$/.test(rest) ? "zf" + String(count * parseInt(rest, 10))
          : "zf" + preCountZF[1] + rest;
    }
  }
  // A count BETWEEN a doubled operator's chars works too (motion.txt:67-69): d2d == 2dd,
  // gu2u / gu2gu == 2guu.
  const midCount = raw.match(/^(.)([1-9]\d*)(.)$/);
  if (midCount && DOUBLE_OPERATORS[midCount[1]] && midCount[3] === midCount[1]) {
    const down = parseInt(midCount[2], 10) - 1;
    raw = down === 0 ? midCount[1] + midCount[1]
      : midCount[1] + (down > 1 ? String(down) : "") + "j";
  }
  const midCountG = raw.match(/^g([uU~?])([1-9]\d*)(g?)(.)$/);
  if (midCountG && midCountG[4] === midCountG[1]) {
    const down = parseInt(midCountG[2], 10) - 1;
    raw = down === 0 ? "g" + midCountG[1] + midCountG[1]
      : "g" + midCountG[1] + (down > 1 ? String(down) : "") + "j";
  }

  let operator = "go";
  let spec     = raw;
  // zf{motion} -- a real OPERATOR (fold.txt:322-323, "Operator to create a fold"), not the bare
  // zf/zF selection-fold from B112/B113. Checked before the single-char OPERATORS dispatch since
  // "z" is not a key there; standaloneCommand already claimed a LITERAL bare "zf"/"zF" (it returns
  // early, so raw.length===2 here only happens via the preCountZF rewrite below for "2zf" with no
  // motion yet -- that must reach spec==="" pending guidance, not fall through to Invalid).
  if (raw.length >= 2 && raw[0] === "z" && raw[1] === "f") {
    operator = "fold";
    spec     = raw.slice(2);
  } else if (raw.length >= 2 && raw[0] === "g" && CASE_OPERATORS[raw[1]]) {
    operator = CASE_OPERATORS[raw[1]];
    // guu / gUU / g~~ / g?? and the long synonyms gugu / gUgU / g~g~ / g?g? (change.txt:329,
    // :349, :359, :369) -- the doubled case operator acts on the whole current line.
    if ((raw.length === 3 && raw[2] === raw[1])
            || (raw.length === 4 && raw.slice(2) === raw.slice(0, 2))) {
      return wholeLineCommand(operator);
    }
    spec = raw.slice(2);
  } else if (raw.length === 2 && DOUBLE_OPERATORS[raw[0]] && raw[1] === raw[0]) {
    return wholeLineCommand(DOUBLE_OPERATORS[raw[0]]);
  } else if (raw.length > 0 && OPERATORS[raw[0]]) {
    operator = OPERATORS[raw[0]];
    spec     = raw.slice(1);
  }

  // Vim's cw/cW special case: on a non-blank the change operator treats a word motion like ce/cE
  // (to the word END, inclusive), so it keeps the trailing whitespace (normal.c nv_wordcmd). But
  // when the cursor is already on the LAST char of a word, Vim changes only that one char (the
  // end_word `stop` param) instead of running into the next word.
  let forcedTarget = null;
  if (operator === "change") {
    const changeWord = spec.match(/^([1-9]\d*)?([wW])$/);
    const text = ctx.lineText(ctx.currentLine);
    const here = text[ctx.currentChar];
    if (changeWord && here !== undefined && !/\s/.test(here)) {
      const bigWord = changeWord[2] === "W";
      const classOf = (c) => c === undefined ? 0
        : bigWord ? (charClass(c, ctx.wordSeparators) === 0 ? 0 : 1)
          : charClass(c, ctx.wordSeparators);
      if (!changeWord[1] && classOf(text[ctx.currentChar + 1]) !== classOf(here)) {
        forcedTarget = position(ctx.currentLine, ctx.currentChar, "Change one character"
                    , "vim");
        forcedTarget.inclusive = true;
      } else {
        spec = (changeWord[1] || "") + (bigWord ? "E" : "e");
      }
    }
  }

  const verb   = VERB[operator];
  const target = forcedTarget || parseTarget(spec, ctx);

  // zf{motion} whose span covers ONE line folds nothing. `createFoldingRangeFromSelection` guards
  // with `endLine > startLine` (its `invoke` reads `a=r.endLineNumber; r.endColumn===1&&--a;
  // a>r.startLineNumber && push(...)`), so a same-line selection pushes no range at all. Vim CAN
  // hold a one-line fold, VS Code cannot -- and `zfw` / `zfaw` / `zf$` / `zf0` all resolve inside
  // the current line, so without this they would report a fold they never created. Exactly the
  // defect B113 caught for `1zF`; the same guard has to cover the operator form too.
  if (operator === "fold") {
    const span = target.kind === "position" ? [ctx.currentLine, target.line]
      : target.kind === "range" ? [target.start.line, target.end.line]
        : null;
    if (span && Math.abs(span[1] - span[0]) < 1) {
      return { operator: "go", target  : { kind: "none", origin: "vim" }
                , label   : "That covers one line -- VS Code cannot fold a single line."
                , detail  : `Vim ${raw} -- a fold needs a span of 2+ lines (try zfj, zfip, zf5).` };
    }
  }

  // position -> TOP = the destination coordinate (always with character), BOTTOM = the type note.
  if (target.kind === "position") {
    return { operator, target, detail: capitalize(target.description)
            , label : `${verb} ${coordinate(target.line, target.character)}.` };
  }
  // range -> an explicit two-coordinate span; TOP names both ends, BOTTOM the size. Only the
  // select / edit operators take a range; a single-target operator with a range is invalid.
  if (target.kind === "range") {
    if (!RANGE_VERB[operator]) {
      // collapse to a "none" target so a dead input does nothing on Enter.
      return { operator, target: { kind: "none" }
                , label : INVALID_LABEL, detail: INVALID_DETAIL };
    }
    return { operator, target
            , label: rangeLabel(operator, target), detail: rangeDetail(operator, target) };
  }
  // bracket has no parse-time coordinate (it needs the editor tokenizer) -- showPicker fills the
  // TOP at preview time via jumpToBracket; this is the placeholder.
  if (target.kind === "bracket") {
    return { operator, target, label: `${verb} the matching bracket.` };
  }
  // empty box -> help prompt, or guidance when an operator is waiting for its target (Group A).
  if (spec === "") {
    if (operator !== "go") {
      return { operator, target
                , label : `Type a target to ${ACTION[operator]}.`
                , detail: "5 = line 5, w = word, $ = end, gg = top" };
    }
    return { operator, target
            , label: labelLinePrompt(ctx.currentLine + 1, ctx.currentChar + 1, ctx.totalLines) };
  }
  // a parsed command with no target (find char missing, no word ahead) -> its own message.
  if (target.message) {
    return { operator, target, label: target.message };
  }
  // a valid PREFIX still being typed -> a pending guide; only truly-dead input -> invalid.
  const pending = pendingMessage(spec, ctx, operator);
  if (pending) {
    const command = { operator, target, label: pending.label, detail: pending.detail };
    // carry a Vim-half prefix's origin through so applyMode can gate it (B103)
    if (pending.origin) command.origin = pending.origin;
    return command;
  }
  return { operator, target, label: INVALID_LABEL, detail: INVALID_DETAIL };
};

// Origin of a RESOLVED command, per logic-classification.md (the persistent contract -- read it
// before touching this). An operator CHARACTER is Vim outright: its presence makes the whole
// command Vim regardless of the target that follows (d5 / y50%+1 / c+3 are Vim, not "mixed"). A
// self-contained action (the one-shots and the ex commands) is Vim; a bare two-coordinate
// range/select is the box's own "go-to-select"; a bare bracket motion is Vim; a bare position's
// origin was tagged at the exact branch in parseTarget that resolved it. Returns null for an
// unresolved "none" target (pending / invalid / message) -- nothing to classify yet.
const commandOrigin = (command) => {
  const { operator, target } = command;
  // an explicit tag wins -- a message-only command (`ga`) has no target to classify.
  if (command.origin) return command.origin;
  if (operator !== "go") return "vim";
  if (target.kind === "action")  return "vim";
  // a range is the improvement-only `A;B` form UNLESS a Vim text object tagged it (B108)
  if (target.kind === "range")   return target.origin || "improvement";
  if (target.kind === "bracket") return "vim";
  if (target.kind === "position") return target.origin;
  // A "none" target that carries a MESSAGE ("'x' not found ...", "No unmatched '(' ...") came from
  // a motion that ran and found nothing -- it is tagged at that motion's return site, so no-vim
  // rejects it instead of printing a Vim motion's report (B103 class). An untagged "none" is a
  // pending or the empty prompt: nothing resolved, nothing to classify.
  if (target.kind === "none") return target.origin || null;
  return null;
};

// Gate a resolved command by the active mode (`betterGoto.vim`). "no-vim" keeps ONLY
// improvement-origin commands and rejects every Vim origin as Invalid; a null origin (pending /
// already-invalid / a message -- nothing resolved) passes through unchanged. "default" gates
// nothing. ("off" disables the box before parseCommand is reached, at goto().)
const applyMode = (command, mode) => {
  if (mode !== MODE_NO_VIM) return command;
  const origin = commandOrigin(command);
  if (origin === "improvement") return command;
  // null origin = an UNTAGGED pending (the box's own line:col / range / sign grammar), a message,
  // or an already-Invalid result. Only swap the hint on an actual Invalid so it stops advertising
  // the disabled Vim commands; improvement pendings and messages stay as-is. A Vim-half pending
  // never reaches here -- it carries origin "vim" and is rejected below (B103).
  if (origin === null) {
    return command.label === INVALID_LABEL
      ? { ...command, detail: INVALID_DETAIL_NO_VIM }
      : command;
  }
  return { operator: command.operator, target  : { kind: "none" }
        , label   : INVALID_LABEL, detail  : INVALID_DETAIL_NO_VIM };
};

/**
 * Parse the full command box value, gated by `ctx.mode` ("default" | "no-vim"; missing = default).
 * parseCommandCore does the actual grammar; this wrapper is the SINGLE point every return path
 * passes through, so the mode gate can never be missed by a new branch (logic-classification.md).
 *
 * @param {string} value
 * @param {object} ctx
 * @returns {{ operator: string, target: object, label: string }}
 */
const parseCommand = (value, ctx) =>
    applyMode(parseCommandCore(value, ctx), ctx.mode || MODE_DEFAULT);

module.exports = {
    pendingMessage
  , parseCommandCore
  , commandOrigin
  , applyMode
  , parseCommand
};
