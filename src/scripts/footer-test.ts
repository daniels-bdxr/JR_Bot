import assert from "node:assert";
import {
  appendLogLine,
  appendOrReplaceFooter,
  buildFooter,
  FOOTER_MARKER,
} from "../gtd/footers";

function run() {
  const footer = buildFooter({
    type: "action",
    board: "growth",
    list: "actionItems",
    log: ["first"],
  });

  const initial = "Hello world";
  const withFooter = appendOrReplaceFooter(initial, footer);
  assert.ok(withFooter.includes(FOOTER_MARKER));
  assert.ok(withFooter.includes("type: action"));

  const replaced = appendOrReplaceFooter(withFooter, footer);
  assert.ok(replaced.includes(FOOTER_MARKER));
  assert.strictEqual(replaced.split(FOOTER_MARKER).length - 1, 1);

  const appendedLog = appendLogLine(withFooter, "second");
  assert.ok(appendedLog.includes("log:"));
  assert.ok(appendedLog.includes("  - first"));
  assert.ok(appendedLog.includes("  - second"));
}

run();
console.log("footer tests passed");
