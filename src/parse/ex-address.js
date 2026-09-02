/**
 * @file src/parse/ex-address.js
 * @description Ex address arithmetic: one address to a line number, an address pair to a span, and the :s/// delimiter split.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { clamp } = require("../utils/math.js");
// Resolve a single ex line ADDRESS to a 0-based line, or null when unparseable. `.` = current
// line, `$` = last line, a number = that line (1-based, clamped). `0` (valid only as a :move /
// :copy DESTINATION -- "before the first line") resolves to -1. cmdline.txt *:range*.
const resolveExAddress = (addr, ctx) => {
  if (addr === ".") return ctx.currentLine;
  if (addr === "$") return ctx.totalLines - 1;
  if (addr === "0") return -1;
  if (/^[1-9]\d*$/.test(addr)) return clamp(0, ctx.totalLines - 1, parseInt(addr, 10) - 1);
  return null;
};

// The ex ADDRESS SPAN of a `[range]` prefix -> { top, bottom } (0-based, ordered). `%` is the whole
// buffer (cmdline.txt: "% equal to 1,$"); an ABSENT range defaults to the current line, which is
// Vim's default for every `:[range]cmd`. Null when an address is unparseable or negative.
const exRangeSpan = (range, ctx) => {
  if (range === undefined) return { top: ctx.currentLine, bottom: ctx.currentLine };
  if (range === "%") return { top: 0, bottom: Math.max(0, ctx.totalLines - 1) };
  const parts = range.split(",");
  const first = resolveExAddress(parts[0], ctx);
  const last  = parts[1] !== undefined ? resolveExAddress(parts[1], ctx) : first;
  if (first === null || last === null || first < 0 || last < 0) return null;
  return { top: Math.min(first, last), bottom: Math.max(first, last) };
};

// Split an ex :s body on UNESCAPED "/" so a pattern may contain "\/". -> [pattern, replacement,
// flags].
const splitSubstitute = (body) => {
  const parts = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && body[i + 1] === "/") { current += "/"; i++; }
    else if (body[i] === "/") { parts.push(current); current = ""; }
    else current += body[i];
  }
  parts.push(current);
  return parts;
};

module.exports = {
    resolveExAddress
  , exRangeSpan
  , splitSubstitute
};
