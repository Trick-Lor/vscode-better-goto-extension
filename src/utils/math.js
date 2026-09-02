/**
 * @file src/utils/math.js
 * @description Pure numeric helpers: clamping and signed offset-chain arithmetic ("+5+5", "-3").
 * @scope src
 * @updated-at 2026-08-01
 */
"use strict";

const REGEX_SIGNED_TOKEN = /[+-]\d+/g;

/**
 * Clamp a value into [min, max].
 *
 * @param {number} min
 * @param {number} max
 * @param {number} value
 * @returns {number}
 */
const clamp = (min, max, value) => Math.min(Math.max(min, value), max);

/**
 * Sum the signed tokens of a chain ("+5+5" -> 10, "-3" -> -3).
 *
 * @param {string} chain
 * @returns {number}
 */
const sumSigned = (chain) =>
  chain.match(REGEX_SIGNED_TOKEN).reduce((total, token) => total + parseInt(token, 10), 0);

/**
 * Sum a signed offset chain, separating integer terms from percent terms (a token ending in "%").
 * Percent terms share the axis base (% of the file / line length) so they sum into one percent;
 * integer terms sum into one offset. So `+1+10%` -> { ints: 1, pcts: 10 }, making `1%+1%` == `2%`
 * and `10%+1+10%` == `20%+1` -- a percent chain collapses exactly like an integer chain.
 *
 * @param {string} chain
 * @returns {{ints: number, pcts: number}}
 */
const splitChain = (chain) => {
  let ints = 0, pcts = 0;
  for (const token of (chain || "").match(/[+-]\d+%?/g) || []) {
    if (token.endsWith("%")) { pcts += parseInt(token, 10); }
    else { ints += parseInt(token, 10); }
  }
  return { ints, pcts };
};

module.exports = {
    clamp
  , sumSigned
  , splitChain
};
