/**
 * @file src/state/session.js
 * @description In-memory stores that outlive one box opening: the last search, the last f/t find, and the recall cursor.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

const { EMPTY_VALUE } = require("../constants/config.js");

// Command-recall state shared by the open box and the global history commands; one const holder
// (module top stays const-only), in-memory, reset on reload.
// The LAST search pattern, so a later `n` / `N` can repeat it (B108). It lives here rather than
// inside parseCommand because parseCommand must stay PURE and unit-testable -- the picker reads
// this into ctx.lastSearch on open, and writes it back when a search resolves on Enter.
const searchState = {
    pattern  : null    // the raw pattern text, null until the first search
    , backward : false // the direction it was ENTERED with (`?` = backward); N flips it
    , wholeWord: false // set by * / # so a repeat keeps their \b anchors
};

// The latest f/F/t/T, so a later `,` can repeat it in the opposite direction (B110, motion.txt:
// 305-306). Same pure-parseCommand reasoning as searchState -- the picker reads this into
// ctx.lastFind on open, and writes it back only when an f/F/t/T itself resolves (never from a ","
// repeat -- see the comment at the "," branch in parseTarget for why that would break repetition).
const findState = {
    motion: null  // "f" | "F" | "t" | "T", null until the first find
    , char  : null  // the character it searched for
};

const recallState = {
    history: []      // recently committed raw commands, newest first
    , picker : null  // the open box, so the global history commands can drive it
    , index  : -1    // -1 = not browsing (the user's own typed value is showing)
    , stashed: EMPTY_VALUE // typed value saved when browsing starts, restored on the way back
};

module.exports = {
    searchState
  , findState
  , recallState
};
