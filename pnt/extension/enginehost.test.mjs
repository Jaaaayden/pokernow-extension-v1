// The built-in tracker, on real Pyodide: start, capture a game, save, start again.
//
// Needs the built extension (Pyodide and the engine zip are not in the repo):
//   python scripts/build_extension.py && node --test pnt/extension/enginehost.test.mjs
// Skipped, with a note, when dist/extension has not been built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createEngineHost, SAVE_SOON_MS } from "./enginehost.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(ROOT, "dist", "extension");
const PYODIDE = join(DIST, "vendor", "pyodide");
const ZIP = join(DIST, "engine", "pnt.zip");
const built = existsSync(join(PYODIDE, "pyodide.mjs")) && existsSync(ZIP);
const HU = join(ROOT, "tests", "fixtures", "poker_now_log_pgl41zM3_CKphpnKM1DMIosUT.csv");

// PokerNow's export: `entry` quoted with doubled quotes, then `at` and `order`.
function readExport(path) {
  const rows = [];
  const text = readFileSync(path, "utf8");
  const re = /^"((?:[^"]|"")*)",([^,\n]*),(\d+)\r?$/gm;
  for (const m of text.matchAll(re)) rows.push({ entry: m[1].replaceAll('""', '"'), at: m[2], order: Number(m[3]) });
  return rows;
}

function memoryStorage() {
  const store = { bytes: null, saves: 0 };
  store.load = async () => store.bytes;
  store.save = async (bytes) => { store.bytes = bytes.slice(); store.saves += 1; };
  return store;
}

const quiet = { info() {}, warn() {}, error: console.error };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(storage) {
  const { loadPyodide } = await import(pathToFileURL(join(PYODIDE, "pyodide.mjs")).href);
  return createEngineHost({
    loadPyodide,
    indexURL: PYODIDE + "/",
    engineZip: new Uint8Array(readFileSync(ZIP)), // not a Buffer, which Pyodide refuses
    storage,
    log: quiet,
  });
}

test("the built-in tracker captures a game, saves it, and has it after a restart", { skip: !built && "run scripts/build_extension.py first" }, async () => {
  const storage = memoryStorage();
  let host = await start(storage);
  assert.equal(host.request("GET", "/health").body.hands, 0);

  const entries = readExport(HU);
  assert.ok(entries.length > 1000, "the fixture parsed");
  const ingested = host.request("POST", "/ingest", JSON.stringify({ game_id: "g1", entries }));
  assert.equal(ingested.status, 200);
  assert.equal(ingested.body.hands, 188);

  // Captured lines are saved later, not per request: nothing yet.
  assert.equal(storage.saves, 0);
  // Reads never save.
  assert.equal(host.request("GET", "/hud/g1").body.seats.length, 2);
  assert.equal(storage.saves, 0);

  // A person's judgement is saved within a second.
  const alias = host.request("GET", "/players").body[0].alias;
  const renamed = host.request("POST", "/aliases/rename", JSON.stringify({ old: alias, new: "renamed" }));
  assert.equal(renamed.status, 200);
  await sleep(SAVE_SOON_MS + 300);
  assert.equal(storage.saves, 1);

  // A refused request changes nothing, and saves nothing.
  assert.equal(host.request("POST", "/ingest", JSON.stringify({ game_id: "../x", entries: [] })).status, 422);
  await host.flush();
  assert.equal(storage.saves, 1);

  host.close();
  host = await start(storage);
  assert.equal(host.request("GET", "/health").body.hands, 188);
  assert.ok(host.request("GET", "/players").body.some((p) => p.alias === "renamed"));
  host.close();
});
