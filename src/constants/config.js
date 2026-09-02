/**
 * @file src/constants/config.js
 * @description Settings identity and the grammar gate they map onto: the configuration section and its keys, the empty opening value, and the two parse modes.
 * @scope src
 * @updated-at 2026-09-02
 */
"use strict";
// The box opens EMPTY (B105). It used to prefill ":" to mirror the built-in Go to Line box, but that
// colon is a quick-access PREFIX -- meaningful only in the shared Ctrl+P palette, where it picks the
// provider. This box has one provider, so the colon carried no information and forced Vim's ex
// grammar behind a second one (`::w`), a form no Vim user types.
const EMPTY_VALUE  = "";

const CONFIG_SECTION       = "betterGoto";
// Context key the box sets while it is open, so the Up / Down / 2nd-Ctrl+G keybindings in
// package.json only bind there. Set by ui/picker.js, cleared when the picker hides.
const CONTEXT_OPEN         = "betterGoto.boxOpen";
const HISTORY_SIZE_KEY     = "historySize";
const DEFAULT_HISTORY_SIZE = 10;
const ENABLED_KEY          = "enabled";  // off -> the built-in box, so Ctrl+G keeps working
const VIM_KEY              = "vim";      // off -> improvement commands only
/**
 * Off -> the editor stays put while typing: no scroll, no line highlight, no selection span. The
 * 2-line label is NOT preview and keeps describing the destination, so the box still says where
 * Enter goes -- more than Vim itself, which shows nothing until Enter (B116).
 */
const PREVIEW_KEY          = "preview";
// The two settings above map onto one internal grammar gate (logic-classification.md); every parse
// path reads this, never the settings.
const MODE_DEFAULT         = "default";
const MODE_NO_VIM          = "no-vim";

module.exports = {
    EMPTY_VALUE
  , CONFIG_SECTION
  , CONTEXT_OPEN
  , HISTORY_SIZE_KEY
  , DEFAULT_HISTORY_SIZE
  , ENABLED_KEY
  , VIM_KEY
  , PREVIEW_KEY
  , MODE_DEFAULT
  , MODE_NO_VIM
};
