/**
 * @file src/parse/ex-command.js
 * @description Everything typed behind the second colon: the :name lookup, its range form, and the rejection label when no ex command matches.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { dropSpaces } = require("../utils/text.js");
const { INVALID_LABEL } = require("../constants/labels.js");
const {
  EX_ALIAS
  , EX_ACTIONS
  , EX_RANGE_VERB
  , EX_DEST_VERB
  , REGEX_EX_SUB
  , REGEX_EX_SPAN
  , REGEX_EX_DEST
  , REGEX_EX_BARE
} = require("../constants/ex-tables.js");
const { exRangeNote, wholeLineCommand } = require("./label.js");
const { resolveExAddress, exRangeSpan, splitSubstitute } = require("./ex-address.js");
// Build the shared exRange command object for every range verb.
const exRangeCommand = (verb, span, spec, extra) =>
    ({ operator: "go", label   : exRangeNote(verb, span.top, span.bottom, extra && extra.dest)
        , detail  : `Vim :${spec}`
        , target  : Object.assign({ kind  : "action", action: "exRange", verb
            , top   : span.top, bottom: span.bottom }, extra) });

// a function, not a const object, so each rejection returns a fresh object no caller can mutate.
const invalidEx = () => ({ operator: "go", label   : INVALID_LABEL
    , detail  : "ex: w q wq sp vs / [range] d y j > < sort / [range]m|t{addr} / [range]s/pat/new/g"
    , target  : { kind: "none" } });

/**
 * Resolve the ex grammar (everything after the leading ":"). In order: substitute (parsed from the
 * RAW body -- spaces inside a pattern are significant), a `[range]` span command (d y j > < sort),
 * a `[range]` command with a destination (m / t / co), a named command (w q wq sp vs ...), the ex
 * GOTO forms (`5`, `$`, a bare `[range]` -> its last address) which return a { redirect } so
 * parseCommand reuses the plain goto grammar, else Invalid. Ex input never falls into the motion
 * grammar (`::w` is write, NOT the word motion). Citations: change.txt :d 76, :j 135, :< 516,
 * :> 527, :s 648, :y 1099, :co 1421, :m 1431, :sort 1913; cmdline.txt *:range*.
 *
 * @param {string} raw   the ex body, spaces INTACT
 * @param {object} ctx
 * @returns {object}  a command, or { redirect } for the goto forms
 */
const exCommand = (raw, ctx) => {
  const spec = dropSpaces(raw);
  if (spec === "") {
    return { operator: "go", label   : "Type an ex command."
            , detail  : "w = save, q = close, 1,19y = yank lines 1-19, %s/a/b/g = replace"
            , origin  : "vim", target  : { kind: "none" } };
  }
  // :[range]s/{pattern}/{string}/[flags] -- the RAW body, so a pattern may contain spaces.
  const sub = raw.trim().match(REGEX_EX_SUB);
  if (sub) {
    const span = exRangeSpan(sub[1], ctx);
    if (!span) return invalidEx();
    const parts = splitSubstitute(sub[2]);
    const [pattern, replacement, flags] = parts;
    // a 4th part is trailing garbage after the flags -- Vim rejects it (E488), so must we (B125)
    if (parts.length > 3) return invalidEx();
    if (parts.length < 2 || pattern === "") {
      return { operator: "go", label   : "Type the pattern and the replacement."
                , detail  : "s/old/new/  -- add g to replace every match on the line"
                , target  : { kind: "none" } };
    }
    if (!/^[gi]*$/.test(flags || "")) return invalidEx();
    return exRangeCommand("substitute", span, dropSpaces(raw)
            , { pattern, replacement: replacement || "", flags: flags || "" });
  }
  // :[range]{cmd} where the command acts on the span itself: d y j > < sort.
  const span = spec.match(REGEX_EX_SPAN);
  if (span) {
    // `:>>` / `:<<<` shift once per char (change.txt:516,527) -- verb from the first char (B126)
    const shift = /^(>+|<+)$/.test(span[2]);
    const verb  = EX_RANGE_VERB[shift ? span[2][0] : span[2]];
    // a bare `d` / `y` with NO range keeps the tested whole-line path (== dd / yy).
    if (verb && span[1] === undefined && (verb === "delete" || verb === "yank")) {
      return wholeLineCommand(verb);
    }
    if (verb) {
      const resolved = exRangeSpan(span[1], ctx);
      if (!resolved) return invalidEx();
      return exRangeCommand(verb, resolved, spec
        , shift && span[2].length > 1 ? { repeat: span[2].length } : undefined);
    }
  }
  // :[range]m{addr} / :[range]t{addr} / :[range]co{addr} -- move / copy the span after {addr}.
  const dest = spec.match(REGEX_EX_DEST);
  if (dest && EX_DEST_VERB[dest[2]]) {
    const resolved = exRangeSpan(dest[1], ctx);
    const to       = resolveExAddress(dest[3], ctx);
    if (!resolved || to === null) return invalidEx();
    return exRangeCommand(EX_DEST_VERB[dest[2]], resolved, spec, { dest: to });
  }
  if (/^0*[1-9]\d*$/.test(spec)) return { redirect: spec };
  if (spec === "$") return { redirect: "G" };
  // a bare range with no command (`5,9`, `.,$`, `%`) -- Vim moves to the LAST address.
  const bare = spec.match(REGEX_EX_BARE);
  if (bare) {
    const resolved = exRangeSpan(bare[1], ctx);
    if (resolved) return { redirect: String(resolved.bottom + 1) };
  }
  const named = EX_ACTIONS[EX_ALIAS[spec] || spec];
  if (named) {
    return { operator: "go", label   : named.note, detail  : `Vim :${spec}`
            , target  : { kind: "action", action: "ex", commands: named.commands } };
  }
  return invalidEx();
};

module.exports = {
    exRangeCommand
  , invalidEx
  , exCommand
};
