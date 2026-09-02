# Contributing

```
npm install
npm run lint
npm run test:unit
```

`F5` runs the extension. Open `examples/playground.js`, press `Ctrl+G`.

Code: `extension.js` is the entry; `src/parse` + `src/motion` turn text into a command; `src/apply`
+ `src/ui` + `src/state` touch VS Code. Tests: `test/verify-parse.js`.

PR: one change, lint clean, a test row for any new command, its row in the README reference.

Bug: open an issue with what you typed, where the cursor was, what happened, what you expected.
