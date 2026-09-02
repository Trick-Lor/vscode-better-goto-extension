/**
 * @file src/utils/table.js
 * @description The frozen null-prototype lookup-table builder every constants table is built with.
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

/**
 * Build a LOOKUP TABLE with no prototype, then freeze it.
 *
 * Every table here is keyed by RAW USER INPUT, so a plain object literal inherits Object.prototype
 * and silently answers for `toString`, `constructor`, `valueOf`, `__proto__` and friends. Typing
 * `toString` in the box then parsed as a valid command whose label and commands were both undefined,
 * and Enter threw on `for...of undefined` with no catch above it. A null-prototype object cannot
 * answer for a key it was not given, which fixes the whole class rather than one table.
 *
 * @param {object} entries
 * @returns {object} frozen, prototype-less
 */
const table = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

module.exports = { table };
