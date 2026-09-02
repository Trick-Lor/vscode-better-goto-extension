/**
 * @file src/parse/label.js
 * @description Every string the box shows about a resolved command: the two-line prompt, the coordinate wording, the arithmetic and clamp notes, and the range label and detail.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

const { capitalize } = require("../utils/text.js");
const { RANGE_VERB } = require("../constants/vim-tables.js");
const { WHOLE_LINE_LABEL } = require("../constants/labels.js");
// Human note for an action, count-aware (count 1 reads "the character", >1 reads "N characters").
const actionNote = (action, count, char) => {
  const many = count > 1;
  const chars = many ? `${count} characters` : "the character";
  const lines = many ? `${count} lines` : "this line with the line below";
  switch (action) {
    case "deleteCharUnder":  return `Delete ${chars} under the cursor.`;
    case "deleteCharBefore": return `Delete ${chars} before the cursor.`;
    case "replaceChar":      return `Replace ${chars} under the cursor with '${char}'.`;
    case "toggleCaseChar":   return many ? `Toggle the case of ${count} characters.`
      : "Toggle the case of the character under the cursor.";
    case "joinLines":        return many ? `Join ${count} lines.` : `Join ${lines}.`;
    case "joinNoSpace":      return many ? `Join ${count} lines without a space.`
      : "Join this line with the line below (no space).";
    default:                 return "";
  }
};

// Human note for a resolved ex-range command.
const exRangeNote = (verb, top, bottom, dest) => {
  const span = bottom > top ? `lines ${top + 1}-${bottom + 1}` : `line ${top + 1}`;
  switch (verb) {
    case "delete":     return `Delete ${span}.`;
    case "yank":       return `Yank ${span}.`;
    case "join":       return `Join ${span}.`;
    case "indent":     return `Indent ${span}.`;
    case "outdent":    return `Outdent ${span}.`;
    case "sort":       return `Sort ${span}.`;
    case "move":       return `Move ${span} to after line ${dest + 1}.`;
    case "copy":       return `Copy ${span} to after line ${dest + 1}.`;
    case "substitute": return `Substitute in ${span}.`;
    default:           return "";
  }
};

// Built-in's empty-state label shows the current cursor position (1-based).
const labelLinePrompt = (line, character, max) => max > 1
  ? `Current Line: ${line}, Character: ${character}. `
        + `Type a line number between 1 and ${max} to navigate to.`
  : `Current Line: ${line}, Character: ${character}. Type a line number to navigate to.`;

// "Understood, but no target" message for a word/WORD/ge motion that runs off the buffer edge.
const noSpanMessage = (direction) => direction === "backward"
  ? "No word before the cursor" : "No more words after the cursor";

// The resolved destination, always shown WITH the character (1-based) -- a small, deliberate
// divergence from the built-in (which omits the character when none was typed) for clarity.
const coordinate = (line, character) => `line ${line + 1} and char ${character + 1}`;

/**
 * "(current +/- offset)" arithmetic hint shown for a relative part.
 *
 * @param {number} current   1-based current line or character
 * @param {number} offset
 * @returns {string}
 */
const arithmetic = (current, offset) =>
    `(${current} ${offset < 0 ? "-" : "+"} ${Math.abs(offset)})`;

/**
 * BOTTOM note for a relative line move: "Down 10 lines (20 + 10)" / "Up 3 lines (20 - 3)".
 *
 * @param {number} current   1-based current line
 * @param {number} offset
 * @returns {string}
 */
const relLineNote = (current, offset) => {
  const count     = Math.abs(offset);
  const direction = offset < 0 ? "Up" : "Down";
  const noun      = count === 1 ? "line" : "lines";
  return `${direction} ${count} ${noun} ${arithmetic(current, offset)}`;
};

/**
 * BOTTOM note for a relative column move: "right 5 chars (8 + 5)" (left for a negative step). The
 * direction is lowercase -- the column note always follows a line clause; capitalize() upper-cases
 * it when the column is the whole note (e.g. "5l" -> "Right 5 chars").
 *
 * @param {number} current   1-based current character
 * @param {number} offset
 * @returns {string}
 */
const relColNote = (current, offset) => {
  const count     = Math.abs(offset);
  const direction = offset < 0 ? "left" : "right";
  const noun      = count === 1 ? "char" : "chars";
  return `${direction} ${count} ${noun} ${arithmetic(current, offset)}`;
};

// Clamp into [0, max] and report which bound (if any) was hit, for the transparent overshoot note.
const clampAxis = (value, max) =>
    value < 0     ? { value: 0,   bound: "Min" }
      : value > max ? { value: max, bound: "Max" }
        :               { value,      bound: "" };

// Overshoot note: name the landing spot in plain words (last / first line, line end / start).
// "Line 30 (last line)" / "Line 1 (first line)" / "char 9 (line end)" / "char 1 (line start)".
const boundNote = (bound, unit, value) =>
    unit === "line"
      ? `Line ${value + 1} (${bound === "Max" ? "last" : "first"} line)`
      : `char ${value + 1} (line ${bound === "Max" ? "end" : "start"})`;

/**
 * Resolve a relative move on one axis: clamp, then pick the note -- the landing spot on overshoot
 * ("Line 6 (last line)" / "char 1 (line start)"), else the directional arithmetic.
 *
 * @param {number} current
 * @param {number} offset
 * @param {number} max
 * @param {string} unit   "line" | "char"
 * @returns {{value: number, note: string}}
 */
const axisMove = (current, offset, max, unit) => {
  const clamped = clampAxis(current + offset, max);
  if (clamped.bound) {
    return { value: clamped.value, note: boundNote(clamped.bound, unit, clamped.value) };
  }
  const note = offset === 0 ? ""
    : unit === "line" ? relLineNote(current + 1, offset) : relColNote(current + 1, offset);
  return { value: clamped.value, note };
};

/**
 * Build a doubled-operator whole-line command ("dd" / "yy" / ">>") -- no target part to parse.
 *
 * @param {string} operator
 * @returns {{ operator: string, target: object, label: string }}
 */
const wholeLineCommand = (operator) => ({
    operator
    , target: { kind: "wholeLine" }
    , label : WHOLE_LINE_LABEL[operator]
    , detail: "The whole line"
});

/**
 * TOP label for a range -- names both endpoints, or just the line span for the line-wise `V`.
 *
 * @param {string} operator
 * @param {object} target   { start, end }
 * @returns {string}
 */
const rangeLabel = (operator, target) => {
  const verb = RANGE_VERB[operator] || "Select";
  const { start, end } = target;
  if (operator === "selectLine") {
    const top    = Math.min(start.line, end.line) + 1;
    const bottom = Math.max(start.line, end.line) + 1;
    return `${verb} ${top} to ${bottom}.`;
  }
  return `${verb} line ${start.line + 1} and char ${start.character + 1}`
        + ` to line ${end.line + 1} and char ${end.character + 1}.`;
};

/**
 * BOTTOM note for a range. Line-wise (`V`) reads the line span; a char-wise range reads both
 * endpoints the same way ("From line A char a to line B char b").
 *
 * @param {string} operator
 * @param {object} target   { start, end }
 * @returns {string}
 */
const rangeDetail = (operator, target) => {
  const { start, end } = target;
  // a text object names ITSELF ("a word", "inner Block") -- more use than repeating the endpoints
  if (target.note) return capitalize(target.note);
  if (operator === "selectLine") {
    const top    = Math.min(start.line, end.line) + 1;
    const bottom = Math.max(start.line, end.line) + 1;
    return `From line ${top} to line ${bottom}`;
  }
  return `From line ${start.line + 1} char ${start.character + 1}`
        + ` to line ${end.line + 1} char ${end.character + 1}`;
};

module.exports = {
    actionNote
  , exRangeNote
  , labelLinePrompt
  , noSpanMessage
  , coordinate
  , arithmetic
  , relLineNote
  , relColNote
  , clampAxis
  , boundNote
  , axisMove
  , wholeLineCommand
  , rangeLabel
  , rangeDetail
};
