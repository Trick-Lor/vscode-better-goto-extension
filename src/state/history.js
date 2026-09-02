/**
 * @file src/state/history.js
 * @description The recently executed commands ring: append with de-duplication, and the Up / Down recall walk over it.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";

const { recallState } = require("./session.js");

/**
 * Cap the history to size, newest kept. 0 turns recall off entirely and a negative value is read as
 * 0, so a hand-edited settings.json cannot produce a nonsense length. Pure. The box applies this on
 * every open, not only on commit -- a shrunk setting must take effect before the next command is
 * committed, or the entries it just dropped stay reachable with Up (B117).
 *
 * @param {string[]} history Existing history, newest first.
 * @param {number} size      Max entries to keep; 0 = disabled.
 * @returns {string[]}
 */
const trimHistory = (history, size) => history.slice(0, Math.max(0, size));

/**
 * Prepend a command to the history, dropping a consecutive duplicate (shell ignoredups) and capping
 * to size. Pure -- the returned array is new.
 *
 * @param {string[]} history Existing history, newest first.
 * @param {string} value     The committed raw command.
 * @param {number} size      Max entries to keep; 0 = nothing is remembered.
 * @returns {string[]}
 */
const pushHistory = (history, value, size) => {
  const next = history[0] === value ? history.slice() : [value, ...history];
  return trimHistory(next, size);
};

/**
 * Fill the open box with a recalled command, caret at the end and nothing selected (B105: there is
 * no prefilled prefix to skip past, so the whole value is the command).
 *
 * @param {string} value
 */
const recall = (value) => {
  if (!recallState.picker) return;
  recallState.picker.value = value;
  // caret at the END of the recalled command, nothing selected (there is no prefix to skip now)
  recallState.picker.valueSelection = [value.length, value.length];
};

/**
 * Up / 2nd Ctrl+G: step to an older command (the first step lands on the most recent).
 */
const historyPrev = () => {
  if (!recallState.picker || recallState.history.length === 0) return;
  if (recallState.index === -1) recallState.stashed = recallState.picker.value;
  recallState.index = Math.min(recallState.index + 1, recallState.history.length - 1);
    recall(recallState.history[recallState.index]);
};

/**
 * Down: step to a newer command, then back to the in-progress text.
 */
const historyNext = () => {
  if (!recallState.picker || recallState.index === -1) return;
  recallState.index -= 1;
    recall(recallState.index === -1 ? recallState.stashed : recallState.history[recallState.index]);
};

module.exports = {
    trimHistory
  , pushHistory
  , recall
  , historyPrev
  , historyNext
};
