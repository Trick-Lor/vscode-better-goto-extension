"use strict";

/**
 * @file test/verify-command-ids.js
 * @description Verifies that every VS Code command id referenced by extension.js actually EXISTS in
 *   the installed VS Code build. The parse suite cannot catch a wrong id -- a command resolves,
 *   labels correctly and passes every assertion, then does nothing at runtime because
 *   executeCommand was handed a name VS Code has never heard of. Two such ids
 *   (workbench.action.maximizeEditor, workbench.action.openEditorAtIndex1) shipped that way and
 *   survived until an id sweep found them. Run: node test/verify-command-ids.js
 * @scope src
 * @updated-at 2026-08-01
 */

const fs = require("fs");
const path = require("path");

// The bundle that actually ships the command registrations. Its parent folder is the build hash,
// so glob for it rather than hard-coding a version that will rot on the next VS Code update.
const CANDIDATE_ROOTS = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code")
    , "C:/Program Files/Microsoft VS Code"
];
const BUNDLE_TAIL = path.join("resources", "app", "out", "vs", "workbench", "workbench.desktop.main.js");

const findBundle = () => {
  for (const root of CANDIDATE_ROOTS) {
    if (!root || !fs.existsSync(root)) continue;
    const direct = path.join(root, BUNDLE_TAIL);
    if (fs.existsSync(direct)) return direct;
    for (const entry of fs.readdirSync(root)) {          // versioned sub-folder (build hash)
      const nested = path.join(root, entry, BUNDLE_TAIL);
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
};

const main = () => {
  const bundle = findBundle();
  if (!bundle) {
        // Not a failure: this check is machine-specific, and CI has no VS Code install. Say so
        // loudly rather than passing silently, so a green run is never mistaken for a real check.
        console.log("SKIP  no installed VS Code bundle found -- command ids NOT verified");
        process.exit(0);
  }
  // extension.js plus every src/ module: the command tables live in src/constants/ since the
  // split, and a sweep that reads only the entry file reports "8 of 8" while never seeing them.
  const roots = [path.join(__dirname, "..", "extension.js")];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) roots.push(full);
    }
  };
    walk(path.join(__dirname, "..", "src"));
    const source = roots.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    // Strip comments first: a comment naming a WRONG id on purpose (to record what was fixed) must
    // not be read as a live reference.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // Core-editor commands have NO dotted prefix (cursorMove, expandLineSelection, undo), so a
    // prefix-only pattern silently skips them -- this file once reported "54 of 54 exist" while
    // never looking at 5 live ids. Collect from where commands are actually named instead: a
    // `commands:`/`command:` field, or the first element of a [id, args] pair.
    // Inside a commands region, an id sits at the START of an element -- after `[` or `,` -- while
    // an ARG VALUE sits after a `:` (`{to: "down", by: "line"}`). Without that distinction "down"
    // and "line" get collected as commands and then "pass", because any short word occurs somewhere
    // in an 18 MB bundle. A check that reports passes it never really made is worse than no check.
    const atElementStart = /(^|[[,(]\s*)"([a-zA-Z][a-zA-Z0-9._]*)"/g;
    const ids = new Set();
    for (const region of code.match(/commands?\s*:\s*\[[^\]]*\]|commands?\s*:\s*"[^"]+"/g) || []) {
      for (const hit of region.matchAll(atElementStart)) ids.add(hit[2]);
      const single = region.match(/commands?\s*:\s*"([^"]+)"/);
      if (single) ids.add(single[1]);
    }
    for (const hit of code.matchAll(/"((?:editor|workbench)\.[a-zA-Z0-9._]+)"/g)) ids.add(hit[1]);
    // Settings and theme keys share the dotted shape but are not commands; drop the ones this file
    // legitimately uses so they are not reported as missing commands.
    const NOT_COMMANDS = /rangeHighlight|Foreground|Background|^editor\.(fontSize|wordWrap)$/;
    const list = [...ids].filter((id) => !NOT_COMMANDS.test(id));

    const text = fs.readFileSync(bundle, "utf8");
    const missing = list.filter((id) => !text.includes(`"${id}"`));

    console.log(`bundle: ${bundle}`);
    // A hit proves the id exists; a MISS does not prove it does not. Some ids are registered in a
    // loop that builds the name by concatenation (`id: base + i` for openEditorAtIndex1..9), so they
    // never appear as a literal and read as missing here. Treating a miss as a verdict is how
    // openEditorAtIndex1 got "fixed" for a fault it did not have -- so a miss is a prompt to open
    // the bundle and look, not a licence to rename.
    if (missing.length) {
        console.log("  NOT FOUND AS A LITERAL -- confirm by hand before changing anything;"
            + " ids built by concatenation in the bundle show up here even though they exist:");
    }
    for (const id of missing) console.log(`  MISSING  ${id}`);
    console.log(`\n${list.length - missing.length} of ${list.length} command ids exist`
        + (missing.length ? `, ${missing.length} MISSING` : ""));
    process.exit(missing.length ? 1 : 0);
};

main();
