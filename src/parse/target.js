/**
 * @file src/parse/target.js
 * @description Turns the target half of a command into a coordinate, a span, or a rejection -- the line/column grammar, percents, motions, text objects, and two-coordinate ranges.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const {
  DELIMITER
  , RANGE_SEP
  , REGEX_ABS_CHAIN
  , REGEX_BACKSLASH
  , REGEX_BIGWORD
  , REGEX_COL_BASE_PCT
  , REGEX_COL_PCT
  , REGEX_COL_REL_PCT
  , REGEX_DELIM_END
  , REGEX_FIND
  , REGEX_FIND_REPEAT
  , REGEX_GE
  , REGEX_LINE_CHAIN
  , REGEX_LINE_INT
  , REGEX_LINE_PCT
  , REGEX_NUMBER
  , REGEX_PERCENT
  , REGEX_REL_CHAIN
  , REGEX_WORD
} = require("../constants/patterns.js");
const { clamp, splitChain, sumSigned } = require("../utils/math.js");
const { firstNonBlankLanding, lastNonBlank } = require("../utils/text.js");
const {
  blankLine
  , braceCol0
  , lineMotion
  , position
  , sentenceStarts
  , stepMarks
} = require("../motion/line.js");
const { unmatchedBracket } = require("../motion/bracket.js");
const { searchCommand } = require("../motion/search.js");
const { textObject } = require("../motion/text-object.js");
const {
  findChar
  , findDescription
  , spanTarget
  , wordDescription
  , wordwiseDescription
} = require("../motion/word.js");
const {
  axisMove
  , boundNote
  , clampAxis
  , noSpanMessage
  , relColNote
  , relLineNote
} = require("./label.js");
/**
 * Resolve one column token shared by the percent and line+percent grammars: signed offset (+2),
 * absolute base + offset chain (10+2), percent of the line (50%), or plain absolute (10). Returns
 * { character, note } or null when the token is unparseable.
 *
 * @param {string} token
 * @param {number} currentChar 0-based caret column
 * @param {number} maxChar     line length (clamp upper bound)
 * @returns {{character: number, note: string}|null}
 */
const colTarget = (token, currentChar, maxChar) => {
  if (REGEX_REL_CHAIN.test(token)) {
    const moved = axisMove(currentChar, sumSigned(token), maxChar, "char");
    // a net-zero offset has an empty axisMove note; read it as the bare char so a caller that
    // appends ", <col note>" never shows a trailing ", ".
    return { character: moved.value, note: moved.note || `char ${moved.value + 1}` };
  }
  const absChain = REGEX_ABS_CHAIN.exec(token);
  if (absChain) {
    const character = clamp(0, maxChar
            , (parseInt(absChain[1], 10) - 1) + sumSigned(absChain[2]));
    return { character, note: `char ${character + 1}` };
  }
  // base char + percent-of-line OFFSET (+/- M% of the line length): 3+50%, +2-25%, 5+5+50%.
  // Note mirrors the line's base+percent form: the base part, then "right/left M% of the line".
  const basePct = REGEX_COL_BASE_PCT.exec(token);
  if (basePct) {
    const baseToken  = basePct[1];
    const baseSigned = /^[+-]/.test(baseToken);
    const absMatch   = !baseSigned && REGEX_ABS_CHAIN.exec(baseToken);
    const baseRaw    = baseSigned ? currentChar + sumSigned(baseToken)
      : absMatch ? (parseInt(absMatch[1], 10) - 1) + sumSigned(absMatch[2])
        : parseInt(baseToken, 10) - 1;
    const baseClamp = clampAxis(baseRaw, maxChar);
    const parts  = splitChain(basePct[3]); // chain percents fold into the offset %
    const pctOff = parseInt(basePct[2], 10) + parts.pcts;
    const offset = Math.round(maxChar * Math.abs(pctOff) / 100) * (pctOff < 0 ? -1 : 1);
    const chain  = parts.ints;
    const character = clamp(0, maxChar, baseClamp.value + offset + chain);
    // a base that clamps to an edge reads as that landing, not the raw out-of-range arithmetic.
    const baseNote  = baseClamp.bound ? boundNote(baseClamp.bound, "char", baseClamp.value)
      : baseSigned ? relColNote(currentChar + 1, sumSigned(baseToken))
        : `char ${baseClamp.value + 1}`;
    // a net-zero percent offset contributes nothing -- drop its clause entirely, leaving just
    // the base + the real chain tail (the same rule the integer offsets follow).
    let note = baseNote;
    if (pctOff !== 0) {
      note += `, then ${pctOff < 0 ? "left" : "right"} ${Math.abs(pctOff)}% `
                + `of the line (${Math.abs(offset)} ${Math.abs(offset) === 1 ? "char" : "chars"})`;
    }
    // the chain tail shows the ACTUAL chars moved after the percent offset, not the requested
    // chain.
    const beforeChain = clamp(0, maxChar, baseClamp.value + offset);
    const baseEff     = character - beforeChain;
    if (baseEff !== 0) {
      note += `, then ${baseEff < 0 ? "left" : "right"} `
                + `${Math.abs(baseEff)} ${Math.abs(baseEff) === 1 ? "char" : "chars"}`;
    }
    return { character, note };
  }
  // signed/relative percent of the line length (mirrors the line's +N%/-N%): move +/- M% of the
  // line length from the cursor char, optional chain after: +50%, -1%, +20%+2.
  const relPctM = REGEX_COL_REL_PCT.exec(token);
  if (relPctM) {
    const parts = splitChain(relPctM[2]); // chain percents fold into the signed %
    const pct   = parseInt(relPctM[1], 10) + parts.pcts; // signed
    // round the MAGNITUDE then re-sign, so -N% moves the same distance as +N% (Math.round on
    // a signed half-integer rounds toward +inf, which would skew the negative direction).
    const moved = Math.round(maxChar * Math.abs(pct) / 100) * (pct < 0 ? -1 : 1);
    const chain = parts.ints;
    const movedClamp = clampAxis(currentChar + moved, maxChar);
    const character  = clamp(0, maxChar, movedClamp.value + chain);
    const net        = movedClamp.value - currentChar;
    // an overshoot reads as the clamped landing; a net-zero move reads as the bare char.
    let note = movedClamp.bound ? boundNote(movedClamp.bound, "char", movedClamp.value)
      : net === 0 ? `char ${movedClamp.value + 1}`
        : `${net < 0 ? "left" : "right"} ${Math.abs(pct)}% of the line `
                + `(${currentChar + 1} ${net < 0 ? "-" : "+"} ${Math.abs(net)})`;
    // the chain tail shows the ACTUAL chars moved (character - landing), not the requested
    // chain, so a clamped chain does not overstate the distance.
    const relEff = character - movedClamp.value;
    if (relEff !== 0) {
      note += `, then ${relEff < 0 ? "left" : "right"} `
                + `${Math.abs(relEff)} ${Math.abs(relEff) === 1 ? "char" : "chars"}`;
    }
    return { character, note };
  }
  // percent of the line length, with an optional offset chain after: 50%, 50%+2, 50%-1+2.
  const pctM = REGEX_COL_PCT.exec(token);
  if (pctM) {
    const parts = splitChain(pctM[2]); // chain percents fold into the base %
    const pct   = parseInt(pctM[1], 10) + parts.pcts;
    const base  = Math.round(maxChar * pct / 100);
    const baseC = clamp(0, maxChar, base);
    const chain = parts.ints;
    const character = clamp(0, maxChar, base + chain);
    // mirror the line's "At N% of the file (line X)" -- "at" lowercase (capitalize()
    // upper-cases it when the column stands alone).
    let note = `at ${pct}% of the line (char ${baseC + 1})`;
    // the chain tail shows the ACTUAL chars moved (character - base), not the requested chain.
    const pctEff = character - baseC;
    if (pctEff !== 0) {
      note += `, then ${pctEff < 0 ? "left" : "right"} `
                + `${Math.abs(pctEff)} ${Math.abs(pctEff) === 1 ? "char" : "chars"}`;
    }
    return { character, note };
  }
  if (REGEX_NUMBER.test(token)) {
    const character = clamp(0, maxChar, parseInt(token, 10) - 1);
    return { character, note: `char ${character + 1}` };
  }
  return null;
};

/**
 * Parse one endpoint of a range into a concrete { line, character }, via the full coordinate
 * grammar (`resolve` is parseTarget). A coordinate-only gate keeps endpoints to absolute /
 * relative / offset / percent line[:col] -- motions are NOT range endpoints. Returns null when
 * the gate fails or the resolved target is not a plain position.
 *
 * @param {string} part
 * @param {object} ctx
 * @param {function} resolve  parseTarget, passed in to avoid a forward reference
 * @returns {{ line: number, character: number } | null}
 */
const parseEndpoint = (part, ctx, resolve) => {
  const text = part.trim();
  // digits / signs / delimiters / % / a leading "\" only, and never a trailing bare sign (a
  // `+` / `-` with no digit after it is the +/- first-non-blank line MOTION, not a coordinate)
  // -- no motions. "\" replaces "," here (B110): a range endpoint can still be a current-line
  // column (`\5;10:9`), just under the new spelling.
  if (!/^[-+\d:%\\]+$/.test(text) || /[+-]$/.test(text)) return null;
  const resolved = resolve(text, ctx);
  if (resolved.kind !== "position") return null;
  // The range contract is "a missing column = col 1" (design.md). A line-only endpoint (no
  // : or \ column marker) must land at col 0 -- override the first-non-blank column that a
  // bare percent endpoint now resolves to, so `50%;9` matches `5;9` (both col 1).
  const hasColumn = /[:\\]/.test(text);
  return { line: resolved.line, character: hasColumn ? resolved.character : 0 };
};

/**
 * A two-coordinate range "A;B" (`;` only -- `~` is Vim's toggle, `>` the indent operator). Each
 * end may be absolute, relative, an offset chain, or percent line[:col]; a relative SECOND point
 * counts from the FIRST point (A) so the pair reads as a span. The operator at the front decides
 * the act (select / delete / copy / change). Exactly two endpoints, else invalid.
 *
 * @param {string} spec
 * @param {object} ctx
 * @param {function} resolve  parseTarget
 * @returns {object}  { kind: "range", start, end } | { kind: "none" }
 */
const parseRange = (spec, ctx, resolve) => {
  const parts = spec.split(RANGE_SEP);
  if (parts.length !== 2) return { kind: "none" };
  const start = parseEndpoint(parts[0], ctx, resolve);
  if (!start) return { kind: "none" };
  // a relative second point is relative to A, not the cursor -- recentre ctx on the resolved A.
  const endCtx = { ...ctx, currentLine: start.line, currentChar: start.character };
  const end    = parseEndpoint(parts[1], endCtx, resolve);
  if (!end) return { kind: "none" };
  return { kind: "range", start, end };
};

/**
 * Resolve the TARGET part of a command into a plain descriptor. Pure -- no vscode types.
 * ctx = { totalLines, currentLine, currentChar, lineLength(i), lineText(i), viewportTop,
 * viewportBottom }.
 *
 * @param {string} spec
 * @param {object} ctx
 * @returns {object}  { kind: "none" | "position" | "bracket" | "word", ... }
 */
const parseTarget = (spec, ctx) => {
  const { totalLines, currentLine, currentChar, viewportTop, viewportBottom } = ctx;

  if (spec === "") return { kind: "none" };

  // A target that STARTS with ":" is invalid. ":" is a DELIMITER, never a target head: only
  // "\" starts a current-line column (B110), while ":" needs a line number before it (`10:5`).
  // So an operator + a bare ":" (`d:1`) is Invalid, not line 1 (2-line-and-column.md).
  // The ex prefix does not apply here -- a leading ":" is only ex at the very front of the whole
  // value (B105), never inside an operator's target.
  if (spec[0] === ":") return { kind: "none" };

  // TEXT OBJECTS (`iw`, `2a{`, `it`) resolve to an inclusive range. Checked before the motions:
  // no motion starts with "i" or "a", so this cannot shadow one, and an unknown object key falls
  // through to Invalid via the null return.
  const object = textObject(spec, ctx);
  if (object) return object;

  // SEARCH (`/pat`, `?pat`, `n`, `N`, `*`, `#`, `g*`, `g#`). Before the motions for the same
  // reason: none of those keys heads an existing motion, and a non-search spec returns null.
  const search = searchCommand(spec, ctx);
  if (search) return search;

  // word motion w / b / e (optional count) -- self-computed via the \w-class span scan (like
  // W/B/E) so it resolves to a concrete line/character for the preview, not a command on Enter.
  const word = spec.match(REGEX_WORD);
  if (word) {
    const motion    = word[2];
    const count     = word[1] ? parseInt(word[1], 10) : 1;
    const direction = motion === "b" ? "backward" : "forward";
    const edge      = motion === "e" ? "end" : "start";
    const target    = spanTarget(ctx, currentLine, currentChar, true, direction, edge, count);
    if (!target) return { kind: "none", message: noSpanMessage(direction), origin: "vim" };
    const result = position(target.line, target.character, wordDescription(motion, count)
            , "vim");
    if (motion === "e") result.inclusive = true; // e is inclusive for an operator
    return result;
  }

  // f / F / t / T find a character in the current line (resolves to a concrete column).
  const find = spec.match(REGEX_FIND);
  if (find) {
    const count  = find[1] ? parseInt(find[1], 10) : 1;
    const column = findChar(ctx.lineText(currentLine), currentChar, find[2], find[3], count);
    if (column === null) {
      const where = (find[2] === "f" || find[2] === "t") ? "after" : "before";
      return { kind   : "none", origin : "vim"
                , message: `'${find[3]}' not found ${where} the cursor on this line` };
    }
    const target = position(currentLine, column, findDescription(find[2], find[3], count)
            , "vim");
    // a resolved find publishes what it used, so a later "," can repeat it (B110); only a HIT
    // reaches here, mirroring target.search (a miss must not clear the find in use).
    target.find = { motion: find[2], char: find[3] };
    // f / t move forward, so an operator includes the target char (Vim inclusive motion).
    if (find[2] === "f" || find[2] === "t") target.inclusive = true;
    return target;
  }

  // [count], -- repeat the latest f/F/t/T in the OPPOSITE direction (motion.txt:305-306, B110).
  // Needs the last find, which lives in ctx.lastFind (picker layer) so parseCommand stays pure,
  // mirroring ctx.lastSearch. f<->F and t<->T swap (opposite direction, same till-ness).
  const findRepeat = spec.match(REGEX_FIND_REPEAT);
  if (findRepeat) {
    const last = ctx.lastFind;
    if (!last || !last.motion) {
      return { kind: "none", origin: "vim", message: "No previous find character to repeat." };
    }
    const count   = findRepeat[1] ? parseInt(findRepeat[1], 10) : 1;
    // group 2 is "," (counted), group 3 is ";" (bare only). `;` repeats the motion as it was;
    // `,` searches the opposite way.
    const reverse = findRepeat[3]
      ? last.motion
      : { f: "F", F: "f", t: "T", T: "t" }[last.motion];
    const text    = ctx.lineText(currentLine);
    // A repeated TILL sits one column from the match it just consumed, so a naive re-search
    // finds that SAME char forever. Vim's default 'cpoptions' has no ';' (options.txt:2519,
    // "aABceFsz"), and without it a repeat "would skip over it and jump to the following
    // occurrence" (options.txt:2805-2810) -- so nudge the start past the adjacent match. Only
    // the till pair needs this; f/F land ON the char and re-search naturally advances.
    let from = currentChar;
    if (reverse === "t" && text[from + 1] === last.char) from += 1;
    if (reverse === "T" && text[from - 1] === last.char) from -= 1;
    const column = findChar(text, from, reverse, last.char, count);
    if (column === null) {
      const where = (reverse === "f" || reverse === "t") ? "after" : "before";
      return { kind   : "none", origin : "vim"
                , message: `'${last.char}' not found ${where} the cursor on this line` };
    }
    const target = position(currentLine, column, findDescription(reverse, last.char, count)
            , "vim");
    // deliberately NOT target.find -- "latest f, t, F or T" (motion.txt:305) pins to the
    // ORIGINAL command, so a "," must not become the new "latest"; together with the
    // adjacent-skip above, a second "," keeps moving outward instead of flip-flopping.
    if (reverse === "f" || reverse === "t") target.inclusive = true;
    return target;
  }

  // h/j/k/l, optionally chained (3j1l) with per-motion counts: j/k offset the line, h/l the
  // column. Sum each axis, clamp, and note the landing spot when an axis overshoots.
  if (/^(?:(?:[1-9]\d*)?[hjkl])+$/.test(spec)) {
    // Vim runs each token as a SEPARATE command that clamps at the buffer/line edge before the
    // next, so an overshoot mid-chain does not cancel out. Clamp per motion. The cursor cannot
    // rest past the last char, so columns clamp to len-1 (an empty line clamps to 0).
    const lastCol = (l) => Math.max(0, ctx.lineLength(l) - 1);
    let line    = currentLine;
    let column  = currentChar;
    let lineOff = 0;
    let charOff = 0;
    // Which axes the user actually typed a motion on. A j/k-only chain landing on a SHORTER
    // line still shifts the column, but that is the editor keeping the caret in range, not a
    // horizontal motion -- reporting it would invent a move (B107).
    let lineTyped = false;
    let charTyped = false;
    for (const token of spec.match(/(?:[1-9]\d*)?[hjkl]/g)) {
      const count  = token.length > 1 ? parseInt(token, 10) : 1;
      const motion = token[token.length - 1];
      if (motion === "j") {
        lineTyped = true;
        lineOff += count;
        line = clamp(0, totalLines - 1, line + count);
      } else if (motion === "k") {
        lineTyped = true;
        lineOff -= count;
        line = clamp(0, totalLines - 1, line - count);
      } else if (motion === "l") {
        charTyped = true;
        charOff += count;
        column = clamp(0, lastCol(line), column + count);
      } else {
        charTyped = true;
        charOff -= count;
        column = clamp(0, lastCol(line), column - count);
      }
    }
    const maxChar = lastCol(line);
    column = clamp(0, maxChar, column);
    // The note must describe the move the caret ACTUALLY made, not the one that was typed
    // (B107). Because each motion clamps before the next, a chain can request a net of zero and
    // still travel (`5l5h` from char 6 of an 8-char line: `5l` parks on the end, `5h` then lands
    // on char 3), or request 7 and travel 5. Building the note from the requested offsets made
    // it claim a move that never happened -- worst case "The current position" while the caret
    // moved. Deltas below are measured from the final landing; when the request overshot and the
    // caret is parked on an edge, the edge wording is kept because it says more than the
    // arithmetic ("char 8 (line end)" vs "Right 2 chars").
    const axisNote = (start, typed, requested, actual, max, unit) => {
      if (!typed || actual === 0) return "";
      const landing = start + actual;
      // Parked ON an edge after asking for more: name the edge, it says more than the
      // arithmetic. Otherwise state the distance actually travelled -- NOT the requested one,
      // and never an edge the caret is not sitting on.
      return requested !== actual && (landing === 0 || landing === max)
        ? boundNote(landing === 0 ? "Min" : "Max", unit, landing)
        : axisMove(start, actual, max, unit).note;
    };
    const lineNote = axisNote(currentLine, lineTyped, lineOff, line - currentLine
            , totalLines - 1, "line");
    const charNote = axisNote(currentChar, charTyped, charOff, column - currentChar
            , maxChar, "char");
    const note = [lineNote, charNote].filter(Boolean).join(", ") || "The current position";
    // A pure vertical move (only j/k, no h/l) is linewise for an operator (Vim: j/k are MLINE);
    // any horizontal step makes the whole motion charwise.
    return charOff === 0 && lineOff !== 0
      ? lineMotion(line, column, note, "vim")
      : position(line, column, note, "vim");
  }

  // ^ / {count}^ -- first non-blank char of the current line. Vim IGNORES any count on ^, so a
  // leading count is accepted and discarded (`2^` == `^`), not rejected as Invalid.
  if (/^([1-9]\d*)?\^$/.test(spec)) {
    const text = ctx.lineText(currentLine);
    return position(currentLine, firstNonBlankLanding(text)
            , "At the first non-blank character", "vim");
  }

  // I / A -- Vim calls these "insert before the first CHAR" (index.txt:346) and "append after the
  // end of the line" (:333). In VS Code the insert half is free: there is no Normal mode to leave,
  // so typing already inserts. What is left is the CURSOR MOVE, which is why these resolve to a
  // position (and therefore preview) instead of delegating like o / O do. `I` lands exactly where
  // `^` does; `A` lands one past `$`, at the true end of the line.
  // No count on any of these five. index.txt:346, :333, :393, :408, :756 do state one, but what
  // Vim repeats N times is the TYPED TEXT, and this box types nothing -- so N has nothing to act
  // on and the cursor lands in the same place for every N. They used to accept `([1-9]\d*)?` and
  // throw it away, which is the silent-wrong-magnitude failure this file rejects everywhere else
  // (`2zh`, `{count}z^`, `5go`). `o` / `O` are the exception that proves it: there the repeat DOES
  // have something observable to do -- N new lines -- so there it is honoured.
  if (spec === "I") {
    return position(currentLine, firstNonBlankLanding(ctx.lineText(currentLine))
            , "At the first non-blank character, ready to type", "vim");
  }
  if (spec === "A") {
    return position(currentLine, ctx.lineLength(currentLine)
            , "At the end of the line, ready to type", "vim");
  }
  // The lowercase pair and gI, same reasoning: `i` inserts BEFORE the cursor (index.txt:408), so
  // the cursor does not move at all; `a` appends AFTER it (:393), one column right; `gI` is "like
  // I, but always start in column 1" (:756) -- column 1 literally, not the first non-blank.
  // These share a first letter with the text objects (`aw`, `i"`), but only as a PREFIX: the
  // patterns below are anchored to the whole input, so `aw` and `daw` still reach the text-object
  // branch untouched. Bare `a` / `i` were previously Invalid, which is what left them unbuilt.
  if (spec === "i") {
    return position(currentLine, currentChar, "Ready to type before the cursor", "vim");
  }
  if (spec === "a") {
    // one past the cursor, but never past the end of the line
    return position(currentLine, Math.min(currentChar + 1, ctx.lineLength(currentLine))
            , "Ready to type after the cursor", "vim");
  }
  if (spec === "gI") {
    return position(currentLine, 0, "At column 1, ready to type", "vim");
  }

  // W / B / E whitespace-delimited WORD (manual scan, not the \w-class VS Code word commands).
  const bigWord = spec.match(REGEX_BIGWORD);
  if (bigWord) {
    const count     = bigWord[1] ? parseInt(bigWord[1], 10) : 1;
    const direction = bigWord[2] === "B" ? "backward" : "forward";
    const edge      = bigWord[2] === "E" ? "end" : "start";
    const target    = spanTarget(ctx, currentLine, currentChar, false, direction, edge, count);
    if (!target) return { kind: "none", message: noSpanMessage(direction), origin: "vim" };
    const result    = position(target.line, target.character
            , wordwiseDescription(bigWord[2], count), "vim");
    // E lands on the last char of a WORD ahead -- an operator includes it (Vim inclusive).
    if (bigWord[2] === "E") result.inclusive = true;
    return result;
  }

  // ge / gE backward to the end of the previous word (\w-class) / WORD (whitespace).
  const geEnd = spec.match(REGEX_GE);
  if (geEnd) {
    const count  = geEnd[1] ? parseInt(geEnd[1], 10) : 1;
    const target = spanTarget(ctx, currentLine, currentChar, geEnd[2] === "ge"
            , "backward", "end", count);
    if (!target) return { kind: "none", message: noSpanMessage("backward"), origin: "vim" };
    const result = position(target.line, target.character
            , wordwiseDescription(geEnd[2], count), "vim");
    // ge / gE land on a word end -- inclusive for an operator (Vim), like e / E
    result.inclusive = true;
    return result;
  }

  const sentence = spec.match(/^([1-9]\d*)?([()])$/);
  if (sentence) {
    const count   = sentence[1] ? parseInt(sentence[1], 10) : 1;
    const forward = sentence[2] === ")";
    const marks   = sentenceStarts(ctx);
    // Vim: a forward sentence motion with no next sentence stops at the END of the buffer -- it
    // never moves backward. The end-of-buffer stop is forward-only; ( steps sentence starts.
    if (forward) {
      const lastLine = totalLines - 1;
      marks.push({ line: lastLine, character: Math.max(0, ctx.lineLength(lastLine) - 1) });
    }
    const target = stepMarks(marks, currentLine, currentChar, forward, count);
    const noun   = count === 1 ? "sentence" : "sentences";
    return position(target.line, target.character
            , `${forward ? "Forward" : "Backward"} ${count} ${noun}`, "vim");
  }

  // [[ / ]] step `{` in column 0; [] / ][ step `}` in column 0.
  const section = spec.match(/^([1-9]\d*)?(\]\]|\[\[|\]\[|\[\])$/);
  if (section) {
    const count   = section[1] ? parseInt(section[1], 10) : 1;
    const motion  = section[2];
    const forward = motion === "]]" || motion === "][";
    const brace   = (motion === "]]" || motion === "[[") ? "{" : "}";
    // Add the direction's clamp line (BOF for backward, EOF for forward) so a run that finds no
    // brace lands at line 1 / the last line -- and the opposite end is never a spurious target
    // The marks are ordered by line; the final landing column is recomputed below.
    const braces    = braceCol0(ctx, brace);
    const clampLine = forward ? totalLines - 1 : 0;
    const clampMark = { line: clampLine, character: 0 };
    const marks     = forward ? [...braces, clampMark] : [clampMark, ...braces];
    const stepped   = stepMarks(marks, currentLine, currentChar, forward, count, true);
    // Vim finishes a section motion with beginline(BL_WHITE|BL_FIX) -> first non-blank.
    const target = { line     : stepped.line
            , character: firstNonBlankLanding(ctx.lineText(stepped.line)) };
    // the note names the target -- a brace at the line start (column 1) -- in plain words.
    const direction = forward ? "Forward" : "Backward";
    const where     = forward ? "next" : "previous";
    const note      = count === 1
      ? `${direction} to the ${where} '${brace}' at the line start`
      : `${direction} to '${brace}' #${count} at the line start`;
    return position(target.line, target.character, note, "vim");
  }

  // [( / ]) / [{ / ]} -- prev unmatched '(' / next ')' / prev '{' / next '}' = block start/end,
  // reachable from anywhere inside the block.
  const unmatch = spec.match(/^([1-9]\d*)?(\[\(|\]\)|\[\{|\]\})$/);
  if (unmatch) {
    const count   = unmatch[1] ? parseInt(unmatch[1], 10) : 1;
    const motion  = unmatch[2];
    const open    = (motion === "[(" || motion === "])") ? "(" : "{";
    const close   = (motion === "[(" || motion === "])") ? ")" : "}";
    const forward = motion === "])" || motion === "]}";
    let target    = { line: currentLine, character: currentChar };
    for (let i = 0; i < count; i++) {
      const next = unmatchedBracket(ctx, target.line, target.character, open, close, forward);
      if (!next) { target = null; break; }
      target = next;
    }
    if (!target) {
      const want  = forward ? close : open;
      const where = forward ? "after" : "before";
      return { kind   : "none", origin : "vim"
                , message: `No unmatched '${want}' ${where} the cursor` };
    }
    // these are exclusive motions, so an operator stops before the bracket (no inclusive bump).
    return position(target.line, target.character
            , `At the ${forward ? "end" : "start"} of the block ('${forward ? close : open}')`
            , "vim");
  }

  if (spec === "%") return { kind: "bracket", description: "Matching bracket" };
  // $ / {count}$ -- end of the line, and {count-1} lines downward (Vim). Lands ON the last char
  // (|inclusive|), not one past it; an empty target line -> char 1.
  const dollar = spec.match(/^([1-9]\d*)?\$$/);
  if (dollar) {
    const count  = dollar[1] ? parseInt(dollar[1], 10) : 1;
    const line   = clamp(0, totalLines - 1, currentLine + count - 1);
    const len    = ctx.lineLength(line);
    const result = position(line, len === 0 ? 0 : len - 1
            , count > 1 ? `End of line, ${count - 1} down` : "At the end of the line", "vim");
    result.inclusive = true; // an operator (d$/c$) includes the last char via the onAccept bump
    return result;
  }
  if (spec === "0") {
    return position(currentLine, 0, "At the first character of the line", "vim");
  }
  // gM / {count}gM -- to N% across the line text (halfway with no count).
  const gMid = spec.match(/^([1-9]\d*)?gM$/);
  if (gMid) {
    const len      = ctx.lineLength(currentLine);
    const rawCount = gMid[1] ? parseInt(gMid[1], 10) : 50;
    // Vim caps gM at 100%: a count > 100 falls through to the default middle (normal.c:6142).
    const overCap  = Boolean(gMid[1]) && rawCount > 100;
    const pct      = overCap ? 50 : rawCount;
    // land ON a text character: a non-blank line clamps to its last char, not one past the end.
    // Vim uses integer (floor) division -- coladvance(i / 2) / i*count0/100
    // (normal.c:6145), not round.
    const char = len === 0 ? 0 : clamp(0, len - 1, Math.floor(len * pct / 100));
    return position(currentLine, char
            , (gMid[1] && !overCap) ? `At ${pct}% of the line (char ${char + 1})`
              : `At the middle of the line (char ${char + 1})`, "vim");
  }
  // | / {count}| -- go to column N (1-based) on the current line.
  const bar = spec.match(/^([1-9]\d*)?\|$/);
  if (bar) {
    // Vim clamps | to the last char (len-1), never past the end.
    const lastCol = Math.max(0, ctx.lineLength(currentLine) - 1);
    const col = clamp(0, lastCol, bar[1] ? parseInt(bar[1], 10) - 1 : 0);
    return position(currentLine, col, `At char ${col + 1}`, "vim");
  }
  // g_ / {count}g_ -- last non-blank char, [count-1] lines down.
  const gLast = spec.match(/^([1-9]\d*)?g_$/);
  if (gLast) {
    const count  = gLast[1] ? parseInt(gLast[1], 10) : 1;
    const line   = clamp(0, totalLines - 1, currentLine + count - 1);
    const char   = lastNonBlank(ctx.lineText(line));
    const result = position(line, char, "At the last non-blank character", "vim");
    result.inclusive = true; // g_ lands on the last non-blank char -- inclusive for an operator
    return result;
  }
  const paragraph = spec.match(/^([1-9]\d*)?([{}])$/);
  if (paragraph) {
    const count = paragraph[1] ? parseInt(paragraph[1], 10) : 1;
    const step  = paragraph[2] === "}" ? 1 : -1;
    const noun  = count === 1 ? "paragraph" : "paragraphs";
    let line    = currentLine;
    for (let i = 0; i < count; i++) line = blankLine(ctx, line, step);
    const label = `${step > 0 ? "Forward" : "Backward"} ${count} ${noun}`;
    // Vim: forward `}` that runs off the end (no trailing blank line) lands ON the last char of
    // the last line, and the motion becomes inclusive.
    if (step > 0 && line === totalLines - 1 && ctx.lineLength(line) > 0) {
      const result = position(line, Math.max(0, ctx.lineLength(line) - 1), label, "vim");
      result.inclusive = true;
      return result;
    }
    return position(line, 0, label, "vim");
  }
  // H / {count}H -- line {count} from the window top; L / {count}L -- line {count} from the
  // bottom (Vim motion.txt). Both land on the FIRST NON-BLANK of the target line, linewise.
  const winLine = spec.match(/^([1-9]\d*)?([HL])$/);
  if (winLine) {
    const count   = winLine[1] ? parseInt(winLine[1], 10) : 1;
    const fromTop = winLine[2] === "H";
    const line    = fromTop
      ? clamp(viewportTop, viewportBottom, viewportTop + count - 1)
      : clamp(viewportTop, viewportBottom, viewportBottom - count + 1);
    const edge = fromTop ? "top" : "bottom";
    const description = winLine[1]
      ? `Line ${count} from the window ${edge}, first non-blank`
      : `${fromTop ? "Top" : "Bottom"} line of the window`;
    return lineMotion(line, firstNonBlankLanding(ctx.lineText(line)), description, "vim");
  }
  if (spec === "M") {
    // Vim floors on an even-height window; lands on the first non-blank char (motion.txt)
    const mid = Math.floor((viewportTop + viewportBottom) / 2);
    return lineMotion(mid, firstNonBlankLanding(ctx.lineText(mid))
            , "Middle line of the window", "vim");
  }
  // gg / {count}gg -- to line {count} (default first line); G / {count}G -- to line {count}
  // (default last line). Vim (motion.txt): both land on the FIRST NON-BLANK of the target line.
  const topBottom = spec.match(/^([1-9]\d*)?(gg|G)$/);
  if (topBottom) {
    const line = topBottom[1]
      ? clamp(0, totalLines - 1, parseInt(topBottom[1], 10) - 1)
      : (topBottom[2] === "gg" ? 0 : totalLines - 1);
    const description = topBottom[1] ? `Line ${line + 1}, first non-blank`
      : (topBottom[2] === "gg" ? "First line of the file" : "Last line of the file");
    return lineMotion(line, firstNonBlankLanding(ctx.lineText(line)), description, "vim");
  }
  // + / - / _ -- [count] lines down / up / down-(count-1), landing on the FIRST NON-BLANK. Vim
  // Count is BEFORE the sign (`5+`), unlike the box's relative `+5` (col 0).
  const nonBlankLine = spec.match(/^([1-9]\d*)?([-+_])$/);
  if (nonBlankLine) {
    const count = nonBlankLine[1] ? parseInt(nonBlankLine[1], 10) : 1;
    const sign  = nonBlankLine[2];
    const delta = sign === "-" ? -count : sign === "_" ? count - 1 : count;
    const line  = clamp(0, totalLines - 1, currentLine + delta);
    const noun  = Math.abs(delta) === 1 ? "line" : "lines";
    const description = delta === 0 ? "At the first non-blank character"
      : `${delta < 0 ? "Up" : "Down"} ${Math.abs(delta)} ${noun}, first non-blank`;
    return lineMotion(line, firstNonBlankLanding(ctx.lineText(line)), description, "vim");
  }

  // Resolve a range before the percent / line:col branches, which would otherwise pull a
  // trailing range separator into a column; placed after the find motions so they keep ";" as
  // a search char (`f;`).
  // A range needs a point on BOTH sides. Without that test a bare `;` (or `N;`) is split into two
  // empty halves and dies here, never reaching the repeat-find branch below -- which is why `;`
  // sat unbuilt while `,` worked. `5:5;` keeps falling through to the pending-input guidance.
  if (RANGE_SEP.test(spec)) return parseRange(spec, ctx, parseTarget);

  // "N%" = that percent of the file (absolute). "+N%" / "-N%" = relative by that percent of the
  // file from the current line. Both compose with a line-offset chain and/or a column.
  const percentMatch = spec.match(REGEX_PERCENT);
  if (percentMatch) {
    const sign     = percentMatch[1];
    // chain percents share the base (% of the file) so they fold into one percent; chain
    // integers stay a line offset. `1%+1%` == `2%`; `10%+1+10%` == `20%+1`.
    const chain    = splitChain(percentMatch[3]);
    const baseMag  = parseInt(percentMatch[2], 10);
    const percent  = (sign === "-" ? -baseMag : baseMag) + chain.pcts;
    // Vim rejects an absolute percentage over 100 (it beeps, no move -- normal.c:4661); the box
    // reports Invalid rather than clamping to the last line.
    if (!sign && percent > 100) return { kind: "none" };
    // Vim rounds UP: (lines*count+99)/100 = ceil (normal.c:4676). Absolute % only; the
    // box-specific relative +N% keeps round (no Vim equivalent).
    const pctLines = sign
      ? Math.round(totalLines * percent / 100)
      : Math.ceil(totalLines * percent / 100);
    const baseRaw  = sign ? currentLine + pctLines : pctLines - 1;
    const baseClamp = clampAxis(baseRaw, totalLines - 1);
    const base      = baseClamp.value;
    const offset = chain.ints;
    const line   = clamp(0, totalLines - 1, base + offset);
    let note;
    // A move that nets ZERO is not a move: the caret stays exactly put, column included. Tracked
    // as its own flag so the LANDING and the NOTE can never disagree (B106 -- the note used to
    // say "The current position" while the column was still reset to 0).
    let stayPut = false;
    if (sign) {
      // the % move alone drives the arithmetic; an offset chain is shown as its own clause.
      // an overshoot reads as the clamped landing; a net-zero move reads like a relative +0.
      const net = base - currentLine;
      stayPut = !baseClamp.bound && net === 0 && offset === 0 && !percentMatch[4];
      note = baseClamp.bound ? boundNote(baseClamp.bound, "line", base)
        : net === 0
          ? (offset === 0 && !percentMatch[4]
            ? "The current position" : `Line ${base + 1}`)
          : `${net < 0 ? "Up" : "Down"} ${Math.abs(percent)}% of the file `
                    + `(${currentLine + 1} ${net < 0 ? "-" : "+"} ${Math.abs(net)})`;
    } else {
      // show the resolved base line too -- with an offset/column the TOP shows the FINAL
      // line, so without this the percent base would be hidden
      note = `At ${percent}% of the file (line ${base + 1})`;
    }
    // the offset clause shows the ACTUAL lines moved (line - base), not the requested offset,
    // so a clamped percent base does not claim a move that never happened.
    const offEff = line - base;
    if (offEff !== 0) {
      const noun = Math.abs(offEff) === 1 ? "line" : "lines";
      note += `, then ${offEff < 0 ? "up" : "down"} ${Math.abs(offEff)} ${noun}`;
    }
    // a delimiter typed with no column yet (`50%,`) is mid-typing, not a finished jump --
    // return none so the box guides ("type the character") instead of silently landing
    // line-only.
    if (REGEX_DELIM_END.test(spec)) return { kind: "none" };
    // Vim's N% lands on the first non-blank (nv_percent -> beginline BL_SOL|BL_FIX). The
    // box-specific relative +N% keeps col 0, like the box's other relative moves -- EXCEPT when
    // the whole move nets zero (`+0%`, `+50%-50%`): then it is not a move at all and the caret
    // stays exactly where it was, column included (B106; `1j1k` has always behaved this way).
    let character = sign
      ? (stayPut ? currentChar : 0)
      : firstNonBlankLanding(ctx.lineText(line));
    if (percentMatch[4]) {
      const col = colTarget(percentMatch[4], currentChar, ctx.lineLength(line));
      // a bad column is Invalid, not a silent line-only jump
      if (!col) return { kind: "none" };
      character = col.character;
      note += `, ${col.note}`;
    }
    // Vim's {count}% is LINEWISE (nv_percent sets MLINE), like :N / G -- so absolute N% with no
    // explicit column is a line motion. An explicit column or the relative +N% stays charwise.
    return (!sign && !percentMatch[4])
      ? lineMotion(line, character, note, "improvement")
      : position(line, character, note, "improvement");
  }

  // line base + percent OFFSET of M% of the file in lines: `20+10%` = line 20 then down 10% of
  // the file. The base may be absolute (Line N) or signed/relative (+5 = from current); an
  // optional further line chain and a column compose after, mirroring the percent-base `N%+M`.
  const linePct = spec.match(REGEX_LINE_PCT);
  if (linePct) {
    const baseToken  = linePct[1];
    const baseSigned = /^[+-]/.test(baseToken);
    // an absolute base must be a real line (value >= 1) -- `0+10%` / `00+10%` is not line 0.
    if (!baseSigned && !REGEX_LINE_INT.test(baseToken) && !REGEX_LINE_CHAIN.test(baseToken)) {
      return { kind: "none" };
    }
    const chain      = splitChain(linePct[3]); // chain percents fold into the offset %
    const pctOff     = parseInt(linePct[2], 10) + chain.pcts;
    // the base may be a CHAIN: relative (`+5+5` = from current) or absolute+offset
    // (`5+5` = base 5 then +5). A single number stays a plain absolute / relative.
    const absMatch   = !baseSigned && REGEX_ABS_CHAIN.exec(baseToken);
    const baseRaw    = baseSigned ? currentLine + sumSigned(baseToken)
      : absMatch ? (parseInt(absMatch[1], 10) - 1) + sumSigned(absMatch[2])
        : parseInt(baseToken, 10) - 1;
    const baseLine   = clamp(0, totalLines - 1, baseRaw);
    const offLines   = Math.round(totalLines * Math.abs(pctOff) / 100) * (pctOff < 0 ? -1 : 1);
    const chainOff   = chain.ints;
    const line       = clamp(0, totalLines - 1, baseLine + offLines + chainOff);
    const offNoun    = Math.abs(offLines) === 1 ? "line" : "lines";
    let note = baseSigned
      ? relLineNote(currentLine + 1, sumSigned(baseToken))
      : `Line ${baseLine + 1}`;
    note += `, then ${pctOff < 0 ? "up" : "down"} ${Math.abs(pctOff)}% of the file `
              + `(${Math.abs(offLines)} ${offNoun})`;
    if (chainOff !== 0) {
      const chainNoun = Math.abs(chainOff) === 1 ? "line" : "lines";
      note += `, then ${chainOff < 0 ? "up" : "down"} ${Math.abs(chainOff)} ${chainNoun}`;
    }
    // a delimiter typed with no column yet (`5+10%,`) is mid-typing -> none, so the box guides
    // (mirrors the percent-base branch); only reached when linePct[4] is empty.
    if (REGEX_DELIM_END.test(spec)) return { kind: "none" };
    let character = 0;
    if (linePct[4]) {
      const col = colTarget(linePct[4], currentChar, ctx.lineLength(line));
      if (!col) return { kind: "none" };
      character = col.character;
      note += `, ${col.note}`;
    }
    return position(line, character, note, "improvement");
  }

  // Relative line chain (no delimiter): "+5", "+5+5", "-3".
  if (REGEX_REL_CHAIN.test(spec)) {
    const delta = sumSigned(spec);
    const moved = axisMove(currentLine, delta, totalLines - 1, "line");
    // A move to another line lands at column 0 (the sign-first relative family's rule). A move
    // that nets ZERO (`+0`, `+5-5`) is not a move at all, so the caret stays exactly put --
    // column included, like `1j1k` always has (B106). Resetting the column there contradicted
    // both the note ("The current position") and TC-30 ("net-zero -> stay in place").
    return delta === 0
      ? position(currentLine, currentChar, "The current position", "improvement")
      : position(moved.value, 0, moved.note, "improvement");
  }

  // line[:col] where either part may be: signed (relative, "+5"), an absolute base with an offset
  // chain ("50+1" -> 50 then +1), a plain absolute, or empty (current). A signed part counts from
  // the current line / character; an absolute-plus-chain part counts from the typed base.
  // trim each part so spaces around a delimiter ("-1 : 2") do not fall through to built-in
  // parsing -- a signed / offset part must stay a feature, not revert to negative-from-end.
  // "\" + column spec (B110) normalizes to an EMPTY line part here, feeding the exact column
  // grammar the old leading "," used to (`,5` -> `\5`): "\" is never a Vim command head (see
  // REGEX_BACKSLASH), so it cannot collide the way "," did with motion.txt:305-306.
  const backslash  = REGEX_BACKSLASH.test(spec);
  const parts      = backslash ? ["", spec.slice(1)] : spec.split(DELIMITER);
  const linePart   = parts[0].trim();
  const colPart    = parts[1] !== undefined ? parts[1].trim() : undefined;
  const lineSigned = REGEX_REL_CHAIN.test(linePart);
  const colSigned  = colPart !== undefined && REGEX_REL_CHAIN.test(colPart);
  const lineAbsRel = REGEX_LINE_CHAIN.test(linePart);
  const colAbsRel  = colPart !== undefined && REGEX_ABS_CHAIN.test(colPart);
  // an empty line part with an absolute column (`\2`) means the current line, that column.
  const lineEmpty  = linePart === "" && colPart !== undefined && REGEX_NUMBER.test(colPart);
  // a percent column (`,50%`) = that percent across the resolved line's length; `,50%+2` adds
  // an offset, `\3+50%` is a base char + a percent-of-line offset. All percent-bearing column
  // forms route through colTarget so the line:col axis matches the percent axis.
  const colPct     = colPart !== undefined && REGEX_COL_PCT.test(colPart);
  const colBasePct = colPart !== undefined && REGEX_COL_BASE_PCT.test(colPart);
  const colRelPct  = colPart !== undefined && REGEX_COL_REL_PCT.test(colPart);
  const hasFeature = lineSigned || colSigned || lineAbsRel || colAbsRel || lineEmpty
        || colPct || colBasePct || colRelPct;

  // a third delimiter (`5:+3:2`) is malformed -> only one or two parts enter here. A "\" spec
  // always has exactly 2 parts (normalized above), so this never rejects a valid backslash form.
  // (A bare "\" with nothing after it never reaches this far: an empty colPart matches none of
  // the feature checks above, so hasFeature is false and it falls through to pendingMessage's own
  // probe, same as a bare "," used to before B110.)
  if (parts.length <= 2 && hasFeature) {
    // a delimiter with no column yet (`+5:`) is mid-typing -> none, so the box guides for the
    // column (mirrors the percent / linePct branches).
    if (REGEX_DELIM_END.test(spec)) return { kind: "none" };
    // resolve each signed chain once -- reused by both the arithmetic and the note builders.
    const lineSum = lineSigned ? sumSigned(linePart) : 0;
    const colSum  = colSigned ? sumSigned(colPart) : 0;
    // raw (pre-clamp) line + whether this part is a relative offset (drives the note choice).
    let rawLine;
    if (lineSigned) {
      rawLine = currentLine + lineSum;
    } else if (lineAbsRel) {
      const absMatch = linePart.match(REGEX_ABS_CHAIN);
      rawLine = (parseInt(absMatch[1], 10) - 1) + sumSigned(absMatch[2]);
    } else if (REGEX_LINE_INT.test(linePart)) {
      rawLine = parseInt(linePart, 10) - 1;
    } else if (linePart === "") {
      rawLine = currentLine;
    } else {
      return { kind: "none" };
    }
    const lineClamp = clampAxis(rawLine, totalLines - 1);
    const line      = lineClamp.value;
    const maxChar   = ctx.lineLength(line);

    // column: percent (N% of line, +chain), base+percent-offset, signed offset, absolute
    // base+chain, plain number, or none. Percent-bearing forms delegate to colTarget.
    const colMoved = colSigned || colAbsRel || colPct || colBasePct || colRelPct
            || (colPart !== undefined && REGEX_NUMBER.test(colPart));
    let character = 0;
    let colLabel  = "";
    let colAbs    = false; // a plain absolute column -- lets the note read "... of the file"
    if (colPct || colBasePct || colRelPct) {
      const col = colTarget(colPart, currentChar, maxChar);
      if (!col) return { kind: "none" }; // guard, like the percent / linePct call sites
      character = col.character;
      colLabel  = col.note;
    } else if (colMoved) {
      let rawChar;
      if (colSigned) {
        rawChar = currentChar + colSum;
      } else if (colAbsRel) {
        const absMatch = colPart.match(REGEX_ABS_CHAIN);
        rawChar = (parseInt(absMatch[1], 10) - 1) + sumSigned(absMatch[2]);
      } else {
        rawChar = parseInt(colPart, 10) - 1;
      }
      const colClamp = clampAxis(rawChar, maxChar);
      character = colClamp.value;
      // a signed offset that nets zero reads as the bare char, not "right 0 chars (C + 0)".
      colLabel  = colClamp.bound ? boundNote(colClamp.bound, "char", character)
        : colSigned && colSum !== 0 ? relColNote(currentChar + 1, colSum)
          : `char ${character + 1}`;
      colAbs = !colClamp.bound && !colSigned;
    }

    // every axis gets its own label so a mixed note never drops the absolute side. A purely
    // absolute line+col reads "... of the file"; relative / percent just joins the labels.
    const lineLabel = lineClamp.bound ? boundNote(lineClamp.bound, "line", line)
      : lineSigned && lineSum !== 0 ? relLineNote(currentLine + 1, lineSum)
        : linePart !== "" ? `Line ${line + 1}` : "";
    const lineAbs = !lineClamp.bound && !lineSigned && linePart !== "";
    let note;
    if (lineAbs && (!colMoved || colAbs)) {
      note = colMoved
        ? `Line ${line + 1}, char ${character + 1}`
        : `Line ${line + 1} of the file`;
    } else {
      note = [lineLabel, colLabel].filter(Boolean).join(", ");
    }
    return position(line, character, note, "improvement");
  }

  // Plain line[:col], STRICT: clean digits (+ one delimiter) only. Junk like 3j1l/5abc/+5x is
  // rejected, not salvaged to a number; a line past the end clamps to the last line. The column
  // allows 0 (clamps to char 1, matching the empty-line form `\0`); the line VALUE stays >= 1 --
  // `05` is line 5, but `0` / `00` fall through to the `0` start-of-line motion.
  if (!/^0*[1-9]\d*([:\\]\d+)?$/.test(spec)) {
    return { kind: "none" };
  }
  const numbers   = spec.split(DELIMITER).map((part) => parseInt(part, 10));
  const lineClamp = clampAxis(numbers[0] - 1, totalLines - 1);
  const line      = lineClamp.value;
  const hasCol    = numbers.length > 1;
  // Vim ':N' / 'NG' land on the first non-blank; a line-only jump follows suit (matches gg/G). An
  // explicit column is honored as typed. (Range endpoints force col 0 in parseEndpoint, so this
  // does not leak into a range's implicit "col 1" contract.)
  const colClamp  = clampAxis(hasCol ? numbers[1] - 1 : firstNonBlankLanding(ctx.lineText(line))
        , ctx.lineLength(line));
  const character = colClamp.value;
  const lineLabel = lineClamp.bound
    ? boundNote(lineClamp.bound, "line", line) : `Line ${line + 1}`;
  let note;
  if (!hasCol) {
    note = lineClamp.bound ? lineLabel : `Line ${line + 1} of the file`;
  } else {
    const colLabel = colClamp.bound
      ? boundNote(colClamp.bound, "char", character)
      : `char ${character + 1}`;
    note = (lineClamp.bound || colClamp.bound)
      ? `${lineLabel}, ${colLabel}`
      : `Line ${line + 1}, char ${character + 1}`;
  }
  // A bare line address (`5`, no column) is linewise for an operator, like Vim `:5` / `5G`; an
  // explicit `5:3` stays charwise. This plain line[:col] is the built-in Go to Line/Column clone
  // (2-line-and-column.md) -- tagged improvement (it is the box's own core feature, though its
  // parity with built-in and Vim's `:5`/`5G` landing overlap is documented, not a Vim citation).
  return hasCol ? position(line, character, note, "improvement")
    : lineMotion(line, character, note, "improvement");
};

module.exports = {
    colTarget
  , parseEndpoint
  , parseRange
  , parseTarget
};
