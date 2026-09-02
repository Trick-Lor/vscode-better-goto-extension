# Change Log

## [1.0.0] - 2026-08-04

First Marketplace release. `Ctrl+G` becomes a command box: everything the built-in Go to
Line/Column accepts, plus a Vim grammar on top.

- Vim motions, text objects, search, operators (`v` `V` `d` `y` `c` `>` `<` `=` `gu` `gU` `g~`
  `g?` `gq` `zf`), one-shots, paste, folds, and ex commands behind `:` (`:w` `:q` `:sp`,
  `[range]` `d` `y` `j` `>` `<` `sort` `m` `t` `s///`). Full list in the README.
- Settings `betterGoto.enabled`, `.vim`, `.preview`, `.historySize`.
- Changed from 0.0.1: a signed line is always relative (use `G` for from-end); `0` is start of
  line; the box opens empty.
- Limits: no dot-repeat, macros, marks, or `:s///c`; `:s` uses JavaScript regex.

## [0.0.1]

- Clone of the built-in Go to Line/Column with `+n` / `-n`, `N%`, live preview and Escape restore.
