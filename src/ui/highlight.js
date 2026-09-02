/**
 * @file src/ui/highlight.js
 * @description The two editor-appearance values the box uses while it is open: how a target is scrolled into view, and the whole-line decoration that marks it.
 * @scope src
 * @updated-at 2026-08-03
 */
"use strict";
const vscode = require("vscode");

// Built-in uses revealRangeInCenter with ScrollType.Smooth; the extension API has no Smooth
// reveal type, so InCenter is the closest available.
const REVEAL_TYPE = vscode.TextEditorRevealType.InCenter;

// match built-in's whole-line range highlight + full-lane overview-ruler marker
const HIGHLIGHT = {
    isWholeLine       : true
    , backgroundColor   : new vscode.ThemeColor("editor.rangeHighlightBackground")
    , overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.rangeHighlightForeground")
    , overviewRulerLane : vscode.OverviewRulerLane.Full
};

module.exports = {
    REVEAL_TYPE
  , HIGHLIGHT
};
