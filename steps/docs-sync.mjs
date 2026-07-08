#!/usr/bin/env node
// Fill code blocks, diffs, and transcripts in the docs FROM the canonical source,
// so the tutorial's code can never drift from the code readers actually run — it
// is generated from the same source. Placeholders (HTML comments) in the .md:
//
//   <!-- @snippet lang=ts file=agent.ts region=loop step=1 -->
//   ```ts
//   ...generated, do not edit...
//   ```
//   <!-- @endsnippet -->
//
//   <!-- @diff file=tools.ts step=2 lang=ts -->  ```diff ... ```  <!-- @enddiff -->
//   <!-- @transcript step=1 lang=ts -->          ``` ... ```      <!-- @endtranscript -->
//
// Usage: node steps/docs-sync.mjs          # write
//        node steps/docs-sync.mjs --check   # fail if any doc is out of date (CI)

import { startMock } from "./mock-anthropic.mjs";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { tmpdir } from "os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const DIST = join(HERE, "dist");
const SCEN = join(HERE, "scenarios");
const check = process.argv.includes("--check");

if (!existsSync(DIST)) spawnSync("node", [join(HERE, "build.mjs")], { stdio: "inherit" });
const stepDirs = readdirSync(DIST).sort();
const stepName = (n) => stepDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));
const langOf = { ts: "typescript", py: "python" };

const REGION = /^\s*(?:\/\/#|#)region\s+(\S+)\s*$/;
const ENDREGION = /^\s*(?:\/\/#|#)endregion\s*$/;

function extractRegion(file, lang, step, region) {
  const path = join(DIST, stepName(step), lang, file);
  if (!existsSync(path)) throw new Error(`no ${file} at step ${step} (${lang})`);
  const lines = readFileSync(path, "utf-8").split("\n");
  let out = null;
  for (const line of lines) {
    const m = line.match(REGION);
    if (m && m[1] === region) { out = []; continue; }
    if (out && ENDREGION.test(line)) break;
    if (out) out.push(line);
  }
  if (out === null) throw new Error(`region "${region}" not found in ${file} at step ${step} (${lang})`);
  if (!out.length) throw new Error(`region "${region}" is empty in ${file} at step ${step} (${lang})`);
  // dedent by the common leading whitespace
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return out.map((l) => l.slice(indent)).join("\n").replace(/\s+$/, "");
}

function diffBlock(file, step, lang) {
  const prev = stepName(step - 1), cur = stepName(step);
  if (!prev) throw new Error(`@diff needs a previous step (step ${step})`);
  const r = spawnSync("git", ["--no-pager", "diff", "--no-index", "--unified=2", "--",
    join(DIST, prev, lang, file), join(DIST, cur, lang, file)], { encoding: "utf-8" });
  // keep only hunks (drop the diff/index/+++/--- header lines so paths/temp don't leak)
  const body = (r.stdout || "").split("\n").filter((l) => /^[-+ @]/.test(l) && !/^(\+\+\+|---)/.test(l)).join("\n");
  return body.trim();
}

function normalizeTranscript(s, workdir) {
  return s
    .split(workdir).join(".")                       // sandbox path -> .
    .replace(/\x1b\[[0-9;]*m/g, "")                 // strip ANSI
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")         // stabilize dates
    .replace(/\s+$/gm, "").trim();
}

async function transcript(step, lang) {
  const map = JSON.parse(readFileSync(join(SCEN, "_map.json"), "utf-8"));
  const scenario = JSON.parse(readFileSync(join(SCEN, map[String(step)].scenario + ".json"), "utf-8"));
  const workdir = join(tmpdir(), `doctx-${process.pid}-${step}-${lang}`);
  rmSync(workdir, { recursive: true, force: true }); mkdirSync(workdir, { recursive: true });
  for (const [f, c] of Object.entries(scenario.setup?.files || {})) { const p = join(workdir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
  const header = `$ node steps/run.mjs ${step}${lang === "py" ? " --py" : ""}\n  you: ${scenario.prompt}\n`;
  let body = "";
  if (lang === "py") {
    const env = { ...process.env }; for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
    const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(HERE, "_pydriver.py"), join(DIST, stepName(step), "py"), join(SCEN, map[String(step)].scenario + ".json"), join(workdir, "_e.jsonl"), workdir], { encoding: "utf-8", env });
    body = r.stdout || "";
  } else {
    const tsDir = join(DIST, stepName(step), "ts");
    spawnSync(join(REPO, "node_modules", ".bin", "tsc"), ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, "agent.ts")], { encoding: "utf-8" });
    const mock = await startMock({ scenario, logPath: join(workdir, "_e.jsonl") });
    const prev = { cwd: process.cwd(), base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, write: process.stdout.write };
    let out = ""; process.stdout.write = (s) => { out += s; return true; };
    process.env.ANTHROPIC_BASE_URL = mock.url; process.env.ANTHROPIC_API_KEY = "test"; process.chdir(workdir);
    try { const mod = await import(pathToFileURL(join(tsDir, "agent.js")).href + `?t=${Date.now()}`); await new mod.Agent().chat(scenario.prompt); }
    finally { process.stdout.write = prev.write; process.chdir(prev.cwd); process.env.ANTHROPIC_BASE_URL = prev.base; process.env.ANTHROPIC_API_KEY = prev.key; await mock.close(); }
    body = out;
  }
  rmSync(workdir, { recursive: true, force: true });
  return normalizeTranscript(header + body, workdir);
}

// Replace the content between an open placeholder and its @end<kind> with `block`.
function replaceBlock(text, kind, open, close, block) {
  const openIdx = text.indexOf(open);
  const closeIdx = text.indexOf(close, openIdx);
  if (openIdx < 0 || closeIdx < 0) throw new Error(`unbalanced @${kind}`);
  const before = text.slice(0, openIdx + open.length);
  const after = text.slice(closeIdx);
  return `${before}\n${block}\n${after}`;
}

const PLACEHOLDER = /<!--\s*@(snippet|diff|transcript)\s+([^>]*?)\s*-->/g;
function parseAttrs(s) { const o = {}; for (const m of s.matchAll(/(\w+)=(\S+)/g)) o[m[1]] = m[2]; return o; }

async function syncFile(path) {
  let text = readFileSync(path, "utf-8");
  const original = text;
  for (const m of [...text.matchAll(PLACEHOLDER)]) {
    const kind = m[1], a = parseAttrs(m[2]);
    const open = m[0], close = `<!-- @end${kind} -->`;
    let block;
    if (kind === "snippet") block = "```" + (langOf[a.lang] || a.lang) + "\n" + extractRegion(a.file, a.lang, Number(a.step), a.region) + "\n```";
    else if (kind === "diff") block = "```diff\n" + diffBlock(a.file, Number(a.step), a.lang) + "\n```";
    else block = "```\n" + (await transcript(Number(a.step), a.lang)) + "\n```";
    text = replaceBlock(text, kind, open, close, block);
  }
  const changed = text !== original;
  if (changed && !check) writeFileSync(path, text);
  return changed;
}

const docDirs = [join(REPO, "docs"), join(REPO, "en", "docs")];
let changedAny = false;
for (const d of docDirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((f) => f.endsWith(".md"))) {
    try { if (await syncFile(join(d, f))) { changedAny = true; console.log(`${check ? "OUT OF DATE" : "synced"}: ${join(d, f).replace(REPO + "/", "")}`); } }
    catch (e) { console.error(`ERROR in ${f}: ${e.message}`); process.exit(2); }
  }
}
if (check && changedAny) { console.error("\ndocs are out of date — run: node steps/docs-sync.mjs"); process.exit(1); }
console.log(check ? "docs in sync" : "docs-sync done");
