# Privacy

Better Go to Line/Column collects nothing: no telemetry, no analytics, no network requests.

It reads the open file to work out where a command lands, uses the system clipboard for `y` / `d`
/ `p`, reads its four `betterGoto.*` settings, and keeps your recent commands in memory only
(gone when the window closes; `betterGoto.historySize` = `0` turns that off).

Questions: [open an issue](https://github.com/Trick-Lor/vscode-better-goto-extension/issues).
