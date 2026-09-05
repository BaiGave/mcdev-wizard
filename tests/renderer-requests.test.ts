import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../gui/renderer-src/boot.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("boot.ts", source, ts.ScriptTarget.Latest, true);
const names = ["searchAdaptMods", "selectAdaptResult", "backToAdaptResults"];
const functions: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, names.length);
const code = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function renderer() {
  const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const context = vm.createContext({
    adaptState: { searchRequestId: 0, resolveRequestId: 0, results: [], target: null, lastSourceResult: null },
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    $: () => null, hideError: () => {}, setText: () => {},
    renderAdaptResults: () => {}, renderAdaptDetail: () => {}, setAdaptDetailMode: () => {},
    requestAnimationFrame: () => {}, adaptSearchParams: () => new URLSearchParams(),
    showError: (message: string) => { throw new Error(message); },
  });
  vm.runInContext(code, context);
  return { context, requests };
}

describe("adaptation center request ordering", () => {
  it("keeps the newest search when an older response arrives last", async () => {
    const { context, requests } = renderer();
    const first = context.searchAdaptMods();
    const second = context.searchAdaptMods();
    requests[1].resolve({ results: ["new"], totalHits: 1 });
    await second;
    requests[0].resolve({ results: ["old"], totalHits: 1 });
    await first;
    assert.equal(context.adaptState.results[0], "new");
  });

  it("ignores an obsolete search failure", async () => {
    const { context, requests } = renderer();
    const first = context.searchAdaptMods();
    const second = context.searchAdaptMods();
    requests[1].resolve({ results: ["new"], totalHits: 1 });
    await second;
    requests[0].reject(new Error("old request failed"));
    await first;
  });

  it("does not reopen a result after returning to the search list", async () => {
    const { context, requests } = renderer();
    const pending = context.selectAdaptResult({ projectId: "old" });
    context.backToAdaptResults();
    requests[0].resolve({ target: { modId: "old" } });
    await pending;
    assert.equal(context.adaptState.target, null);
  });
});
