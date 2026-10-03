// Node-only fixture loading. Kept out of src/index.ts so the main entry stays browser-safe;
// import it through the package subpath "@apprentice/agent/node".

import { readFileSync } from "node:fs";
import type { ScreenFixture } from "./screen-bridge.ts";

export function loadFixture(path: string | URL): ScreenFixture {
  return JSON.parse(readFileSync(path, "utf8")) as ScreenFixture;
}

/** The Learn fixture shipped in fixtures/agent. */
export const LEARN_CUSTOMER07_FIXTURE_URL = new URL("../../../../fixtures/agent/learn-customer07.json", import.meta.url);

export function loadLearnCustomer07(): ScreenFixture {
  return loadFixture(LEARN_CUSTOMER07_FIXTURE_URL);
}
