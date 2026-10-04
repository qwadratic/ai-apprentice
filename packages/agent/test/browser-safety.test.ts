import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { must } from "./helpers.ts";

// src/index.ts is the browser entry: no file in its import graph may import a node: module.
// The only bare specifier allowed is the workspace package @apprentice/contracts (browser-safe, canonical screen types);
// every other import must be relative.
const ALLOWED_PACKAGES = new Set(["@apprentice/contracts"]);
const SRC = new URL("../src/", import.meta.url);
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g;

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => must(m[1]));
}

test("src/index.ts import graph is free of node: modules", () => {
  const seen = new Set<string>();
  const queue = [new URL("index.ts", SRC)];
  while (queue.length > 0) {
    const url = must(queue.pop());
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    for (const spec of specifiers(readFileSync(url, "utf8"))) {
      assert.ok(!spec.startsWith("node:"), `${url.pathname} imports ${spec}`);
      if (ALLOWED_PACKAGES.has(spec)) continue;
      assert.ok(spec.startsWith("."), `${url.pathname} imports non-relative ${spec}`);
      queue.push(new URL(spec, url));
    }
  }
  assert.ok(seen.size >= 8, "walked the whole graph");
  assert.ok(![...seen].some((h) => h.endsWith("fixture-node.ts")), "Node loader is not reachable from the main entry");
});
