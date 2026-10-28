#!/usr/bin/env node
/**
 * gitstats CLI — counts commits and lines in the git repos on this machine and sends ONLY the
 * numbers (per repo, per week) to your gitstats profile. No file contents, no diffs, no GitHub tokens.
 *
 *   npx @yaroslavhaidash/gitstats-cli@latest link
 *                             pair this computer, scan for repos, sync, install a daily sync
 *                             (--user <login> refuses the pairing if the browser confirms as someone else)
 *   gitstats sync             fetch each repo's default branch, recount the last year, upload (idempotent;
 *                             a repo seen for the first time is counted in full once; --history recounts
 *                             every repo in full; --no-fetch skips the fetch, --no-update skips the daily
 *                             version check)
 *   gitstats stats            count this machine's repos and print the numbers; sends nothing, stores nothing
 *                             (--root <dir> and --email <addr>, both repeatable; --fetch refreshes remotes first)
 *   gitstats status           what is linked, whether the background sync is scheduled, when it last ran
 *   gitstats add <path>       track a repo outside the scanned folders
 *   gitstats roots add <dir>  scan another folder (e.g. one outside your home directory)
 *   gitstats emails add <e>   attribute commits made with another email to you
 *   gitstats names on|off     also send repo names (off by default; your own page then labels private repos by hash)
 *   gitstats pause | resume   stop / restart the background sync without unlinking
 *   gitstats update           fetch the latest published version now (sync does this on its own, once a day)
 *   gitstats unlink           revoke this computer and remove the schedule and local config
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER = "https://gitstats.org";
const PKG = "@yaroslavhaidash/gitstats-cli";
/** The scheduler starts the job with its own environment, not the shell's: launchd hands an agent
 *  the user's real home directory whatever `HOME` was when the plist was written. So the entry
 *  carries the directory it was installed for, and without it nothing changes. */
const HOME = process.env.GITSTATS_HOME ?? homedir();
const DIR = join(HOME, ".gitstats");
const CONFIG = join(DIR, "config.json");
const SELF = join(DIR, "cli");
const DAYS = 365;
/** The server's floor for a full history: commits dated earlier are not counted. */
const HISTORY_FROM = "2000-01-01";
/** What the server accepts in one request; a full history is split into requests under these. */
const MAX_REQUEST_REPOS = 500;
const MAX_REQUEST_WEEKS = 5_000;
const MAX_REQUEST_DAYS = 20_000;
const PENDING_DAYS = 30;
const SYNC_LOG = join(DIR, "sync.log");
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const REGISTRY = `https://registry.npmjs.org/${PKG.replace("/", "%2F")}/latest`;
const SKIP_DIRS = new Set(["node_modules", "Library", "Applications", ".Trash", "vendor", "target", "build", "dist", ".venv", "venv", "__pycache__", "Pods", "DerivedData", "go", ".cargo", ".rustup", ".npm", ".cache", ".local", "snap", "AppData"]);

type Config = {
  server: string;
  token: string;
  /** Per-user key from the server; remote URLs are HMAC'd with it, never sent in clear. */
  salt: string;
  sendNames: boolean;
  login: string;
  githubId: number | null;
  machine: string;
  roots: string[];
  repos: string[];
  emails: string[];
  lastSync?: { at: string; repos: number; weeks: number; error?: string };
  /** When the registry was last asked for a newer version; the check runs at most once a day. */
  lastUpdateCheck?: string;
  /** Remote hashes whose full history this machine has uploaded. Never sent. */
  historySent?: string[];
};

type Week = { weekStart: string; additions: number; deletions: number; commits: number };
type Day = { date: string; additions: number; deletions: number; commits: number };
/** Work sitting on a branch that has not reached the default branch yet. Never ranked, only shown. */
type Buckets = { weeks: Week[]; days: Day[] };
/** `since` only on a full-history upload: the server then replaces that repo's whole series from it. */
type RepoReport = { remoteHash: string; name: string | null; language: string | null; weeks: Week[]; days: Day[]; pending: Buckets; since?: string };
type Counted = RepoReport & { path: string; label: string; isWorktree: boolean };

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

function log(msg: string): void {
  console.log(msg);
}

/** Background runs already redirect their output here; a manual run appends directly so a failed
 *  update check leaves the same trail either way. */
function logFile(msg: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(SYNC_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* the log is best effort; it must never break a sync */
  }
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG)) return null;
  return JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
}

function saveConfig(c: Config): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

function git(cwd: string, ...a: string[]): string | null {
  const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function globalEmail(): string | null {
  const r = spawnSync("git", ["config", "--global", "user.email"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// ---------- repo discovery ----------

function isWorktree(repo: string): boolean {
  try {
    return statSync(join(repo, ".git")).isFile();
  } catch {
    return false;
  }
}

function findRepos(roots: string[], explicit: string[]): string[] {
  const found = new Set<string>(explicit.filter((p) => existsSync(join(p, ".git"))));
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes(".git")) {
      found.add(dir);
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || (e.startsWith(".") && depth > 0)) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* unreadable, skip */
      }
    }
  };
  for (const r of roots) walk(r, 0);
  // Real clones before worktrees, so the dedupe below keeps the primary checkout.
  return [...found].sort((a, b) => Number(isWorktree(a)) - Number(isWorktree(b)) || a.localeCompare(b));
}

/** `remote:github.com/owner/name` (lower-cased, no protocol/user/.git) or `path:<dir>` when there is no remote. */
function remoteInfo(repo: string): { key: string; label: string } {
  const raw = git(repo, "config", "--get", "remote.origin.url")?.trim();
  if (!raw) return { key: `path:${repo}`, label: basename(repo) };
  const norm = raw.replace(/^git@([^:]+):/, "$1/").replace(/^[a-z]+:\/\//, "").replace(/^[^@]+@/, "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  return { key: `remote:${norm}`, label: norm.split("/").slice(-2).join("/") || basename(repo) };
}

/**
 * Refresh origin's default branch so commits pushed from other machines are counted here too.
 * Quiet, no credential prompts, bounded; a failure just means we count what is already local.
 */
function refresh(repo: string, ref: string): void {
  if (!ref.startsWith("origin/")) return;
  spawnSync("git", ["fetch", "-q", "origin", ref.slice("origin/".length)], {
    cwd: repo,
    stdio: "ignore",
    timeout: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
  });
}

function defaultRef(repo: string): string {
  const head = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")?.trim();
  if (head) return head;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(repo, "rev-parse", "--verify", "-q", ref) !== null) return ref;
  }
  return "HEAD";
}

/**
 * Remote branches whose work has not landed on the default branch yet. Only `refs/remotes/origin`
 * counts, and only tips touched in the last 30 days: local branches left behind by squash-merged
 * worktrees are the same commits over again, and they inflated pending by 14x.
 */
function pendingRefs(repo: string, ref: string): string[] {
  const out = git(repo, "for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/remotes/origin");
  if (out === null) return [];
  const cutoff = Date.now() / 1000 - PENDING_DAYS * 86_400;
  const refs: string[] = [];
  for (const line of out.split("\n")) {
    const [name, when] = line.split(" ");
    if (!name || !when) continue;
    const short = name.slice("refs/remotes/".length);
    if (short === ref || short === "origin/HEAD") continue;
    if (Number(when) < cutoff) continue;
    refs.push(name);
  }
  return refs;
}

// ---------- counting ----------

const LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C",
  php: "PHP", html: "HTML", css: "CSS", scss: "SCSS", vue: "Vue", svelte: "Svelte", dart: "Dart", scala: "Scala", ex: "Elixir", exs: "Elixir",
  sql: "SQL", sh: "Shell", zsh: "Shell", lua: "Lua", r: "R", m: "Objective-C", hs: "Haskell", clj: "Clojure", elm: "Elm", tf: "HCL",
};
const NOISE = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum"]);

/** Sunday 00:00 UTC of the week containing `d`, as YYYY-MM-DD — same bucketing as GitHub's stats/contributors. */
function weekStartUtc(d: Date): string {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
  return s.toISOString().slice(0, 10);
}

type Tally = { weeks: Map<string, Week>; days: Map<string, Day>; langLines: Map<string, number> };

/** Read one `git log --numstat` run into week and day buckets. Same rules for merged and pending work. */
function tally(out: string, all: string[]): Tally {
  const weeks = new Map<string, Week>();
  const days = new Map<string, Day>();
  const langLines = new Map<string, number>();
  for (const rec of out.split("\x1e").slice(1)) {
    const [header, ...lines] = rec.split("\n");
    const [, dateStr, authorEmail] = header?.split("\x1f") ?? [];
    // --author is a substring match; keep only exact email matches.
    if (!dateStr || !authorEmail || !all.some((e) => e.toLowerCase() === authorEmail.toLowerCase())) continue;
    const when = new Date(dateStr);
    const ws = weekStartUtc(when);
    const w = weeks.get(ws) ?? { weekStart: ws, additions: 0, deletions: 0, commits: 0 };
    w.commits += 1;
    const date = when.toISOString().slice(0, 10);
    const day = days.get(date) ?? { date, additions: 0, deletions: 0, commits: 0 };
    day.commits += 1;
    for (const l of lines) {
      const [a, d, path] = l.split("\t");
      if (!a || !d || !path || a === "-" || d === "-") continue;
      w.additions += Number(a);
      w.deletions += Number(d);
      day.additions += Number(a);
      day.deletions += Number(d);
      const file = basename(path);
      const ext = file.includes(".") ? file.split(".").pop()!.toLowerCase() : "";
      const lang = LANG[ext];
      if (lang && !NOISE.has(file)) langLines.set(lang, (langLines.get(lang) ?? 0) + Number(a) + Number(d));
    }
    weeks.set(ws, w);
    days.set(date, day);
  }
  return { weeks, days, langLines };
}

function buckets(t: Tally): Buckets {
  return {
    weeks: [...t.weeks.values()].sort((x, y) => x.weekStart.localeCompare(y.weekStart)),
    days: [...t.days.values()].sort((x, y) => x.date.localeCompare(y.date)),
  };
}

const EMPTY_TALLY: () => Tally = () => ({ weeks: new Map(), days: new Map(), langLines: new Map() });

function remoteHash(salt: string, key: string): string {
  return createHmac("sha256", salt).update(key).digest("hex");
}

/** `historyFrom` counts the default branch from that day instead of `since`; pending work stays at `since`. */
function countRepo(repo: string, emails: string[], since: string, salt: string, sendNames: boolean, fetch: boolean, historyFrom: string | null = null): Counted | null {
  const info = remoteInfo(repo);
  const localEmail = git(repo, "config", "user.email")?.trim();
  const all = [...new Set([...emails, ...(localEmail ? [localEmail] : [])])].filter(Boolean);
  if (all.length === 0) return null;
  const ref = defaultRef(repo);
  if (fetch) refresh(repo, ref);
  // --fixed-strings: emails like 123+login@users.noreply.github.com would otherwise be read as regex.
  const common = ["--no-merges", "--fixed-strings", "--numstat", "--date=iso-strict", "--format=%x1e%H%x1f%aI%x1f%ae"];
  const authors = all.map((e) => `--author=${e}`);
  const out = git(repo, "log", ref, `--since=${historyFrom ?? since}`, ...common, ...authors);
  if (out === null) return null;
  const unmerged = pendingRefs(repo, ref);
  const pendingOut = unmerged.length > 0 ? git(repo, "log", ...unmerged, "--not", ref, `--since=${since}`, ...common, ...authors) : null;
  const merged = tally(out, all);
  const pending = pendingOut === null ? EMPTY_TALLY() : tally(pendingOut, all);
  if (merged.weeks.size === 0 && pending.weeks.size === 0) return null;
  const langLines = merged.langLines.size > 0 ? merged.langLines : pending.langLines;
  const language = [...langLines.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  return {
    remoteHash: remoteHash(salt, info.key),
    name: sendNames ? info.label : null,
    language,
    ...buckets(merged),
    pending: buckets(pending),
    ...(historyFrom ? { since: historyFrom } : {}),
    path: repo,
    label: info.label,
    isWorktree: isWorktree(repo),
  };
}

// ---------- server ----------

async function post<T>(server: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body: parsed };
}

function summarize(reports: Counted[]): void {
  for (const r of reports) {
    const a = r.weeks.reduce((n, w) => n + w.additions, 0);
    const d = r.weeks.reduce((n, w) => n + w.deletions, 0);
    const cm = r.weeks.reduce((n, w) => n + w.commits, 0);
    const pending = r.pending.weeks.reduce((n, w) => n + w.commits, 0);
    log(`  ${r.label.padEnd(40)} ${String(cm).padStart(5)} commits  +${a} −${d}${pending > 0 ? `  (${pending} pending)` : ""}${r.since ? "  (full history)" : ""}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

/**
 * `history` counts every repo whose full history this machine has not uploaded yet from
 * HISTORY_FROM, once; the rest get the last year, as always. `progress` names each of those repos as
 * it goes, for `link`, where the first count can take minutes.
 */
function count(c: Config, since: string, fetch = !args.includes("--no-fetch"), history = false, progress = false): { scanned: number; reports: Counted[] } {
  const repos = findRepos(c.roots, c.repos);
  // Worktrees and extra clones share a remote: fetch and count the primary clone only (they read the same origin/HEAD).
  const primary: { path: string; key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const r of repos) {
    const info = remoteInfo(r);
    if (seen.has(info.key)) continue;
    seen.add(info.key);
    primary.push({ path: r, ...info });
  }
  const sent = new Set(c.historySent ?? []);
  const full = history ? primary.filter((r) => !sent.has(remoteHash(c.salt, r.key))).length : 0;
  if (full > 0 && progress) log(`  counting full history for ${full} repos (once)`);
  const reports: Counted[] = [];
  let done = 0;
  for (const r of primary) {
    const historyFrom = history && !sent.has(remoteHash(c.salt, r.key)) ? HISTORY_FROM : null;
    if (historyFrom && progress) log(`  [${++done}/${full}] ${r.label}`);
    const rep = countRepo(r.path, c.emails, since, c.salt, c.sendNames, fetch, historyFrom);
    if (rep) reports.push(rep);
  }
  return { scanned: repos.length, reports };
}

/** Full-history repos in request-sized groups, packed in order. One repo alone always fits the server's per-repo cap. */
function packHistory(reports: Counted[]): Counted[][] {
  const groups: Counted[][] = [];
  let group: Counted[] = [];
  let weeks = 0;
  let days = 0;
  for (const r of reports) {
    if (group.length > 0 && (group.length >= MAX_REQUEST_REPOS || weeks + r.weeks.length > MAX_REQUEST_WEEKS || days + r.days.length > MAX_REQUEST_DAYS)) {
      groups.push(group);
      group = [];
      weeks = 0;
      days = 0;
    }
    group.push(r);
    weeks += r.weeks.length;
    days += r.days.length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

async function send(c: Config, reports: Counted[]): Promise<{ status: number; body: { repos: number; weeks: number; outdated?: boolean; minVersion?: string } | null }> {
  const payload = reports.map(({ remoteHash, name, language, weeks, days, pending, since }) => ({ remoteHash, name, language, weeks, days, pending, ...(since ? { since } : {}) }));
  return post(c.server, "/api/ingest", { cliVersion: runningVersion(), repos: payload }, c.token);
}

/**
 * The first request carries the last-year repos, exactly as before 0.4.0. Full histories follow in
 * further requests, and a repo joins `historySent` only once its request returned 200, so a failed
 * one is counted and sent again next time. Re-sending a history replaces the same rows.
 */
async function upload(c: Config, reports: Counted[]): Promise<{ repos: number; weeks: number; requests: number; history: number; historyLeft: number }> {
  const { status, body } = await send(c, reports.filter((r) => !r.since));
  if (status !== 200 || !body) {
    c.lastSync = { at: new Date().toISOString(), repos: 0, weeks: 0, error: `server answered ${status}` };
    saveConfig(c);
    throw new Error(status === 401 ? "this computer is no longer linked; run `gitstats link` again" : `sync failed: HTTP ${status}`);
  }
  if (body.outdated) log(`this computer runs ${runningVersion()}; the board expects ${body.minVersion} or newer — run \`gitstats update\``);
  const total = { repos: body.repos, weeks: body.weeks, requests: 1, history: 0, historyLeft: 0 };
  const groups = packHistory(reports.filter((r) => r.since));
  let error: string | undefined;
  for (const [i, group] of groups.entries()) {
    const res = await send(c, group);
    total.requests += 1;
    if (res.status !== 200 || !res.body) {
      error = `full history: server answered ${res.status}`;
      total.historyLeft = groups.slice(i).reduce((n, g) => n + g.length, 0);
      break;
    }
    total.repos += res.body.repos;
    total.weeks += res.body.weeks;
    total.history += group.length;
    c.historySent = [...new Set([...(c.historySent ?? []), ...group.map((r) => r.remoteHash)])];
    saveConfig(c);
  }
  c.lastSync = { at: new Date().toISOString(), repos: total.repos, weeks: total.weeks, ...(error ? { error } : {}) };
  saveConfig(c);
  if (groups.length > 0) {
    logFile(`full history: ${total.history} repos sent from ${HISTORY_FROM} in ${total.requests - 1} request${total.requests === 2 ? "" : "s"}${error ? `, ${total.historyLeft} left for the next sync (${error})` : ""}`);
  }
  return total;
}

async function sync(c: Config, quiet = false): Promise<void> {
  const restarted = await selfUpdate(c);
  if (restarted !== null) process.exit(restarted);
  if (args.includes("--history")) {
    c.historySent = [];
    saveConfig(c);
  }
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const { scanned, reports } = count(c, since, !args.includes("--no-fetch"), true, !quiet);
  const body = await upload(c, reports);
  if (!quiet) {
    const full = reports.filter((r) => r.since).length;
    log(`scanned ${scanned} repos, ${reports.length} with your commits${full > 0 ? ` (${full} counted in full, once)` : " in the last year"}, ${body.weeks} weekly rows sent in ${body.requests} request${body.requests === 1 ? "" : "s"}`);
    if (body.historyLeft > 0) log(`${body.historyLeft} full histories were not accepted (${c.lastSync?.error}); the next sync sends them again`);
    summarize(reports);
  }
}

// ---------- scheduler ----------

const BIN = join(DIR, "bin");

/**
 * Put this package in ~/.gitstats/cli so the schedule has an absolute path that survives npx.
 * The PATH shim and every scheduled run already exec the installed copy, so `pkgRoot === SELF` is
 * the normal case for `resume` and a re-run of `link`: replacing the install would mean deleting
 * the very files being read. Then only the shim is rewritten. An install from anywhere else is
 * staged in a temp dir first, so a failed copy can never leave a half-installed ~/.gitstats/cli.
 */
function installSelf(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist
  const pkgRoot = resolve(here, "..");
  if (pkgRoot === resolve(SELF)) return writeShim();
  const tmp = mkdtempSync(join(tmpdir(), "gitstats-install-"));
  try {
    cpSync(join(pkgRoot, "dist"), join(tmp, "dist"), { recursive: true });
    cpSync(join(pkgRoot, "package.json"), join(tmp, "package.json"));
    rmSync(SELF, { recursive: true, force: true });
    mkdirSync(SELF, { recursive: true });
    cpSync(join(tmp, "dist"), join(SELF, "dist"), { recursive: true });
    cpSync(join(tmp, "package.json"), join(SELF, "package.json"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return writeShim();
}

/** A `gitstats` command for shells that have ~/.gitstats/bin on PATH; the npx form works regardless. */
function writeShim(): string {
  const script = join(SELF, "dist", "cli.js");
  mkdirSync(BIN, { recursive: true });
  if (platform() === "win32") {
    writeFileSync(join(BIN, "gitstats.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    writeFileSync(join(BIN, "gitstats"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  return script;
}

function readVersion(pkgRoot: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    const v = typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>).version : null;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

function installedVersion(): string {
  return readVersion(SELF);
}

/** The copy that is executing right now — an npx run is not the installed one. */
function runningVersion(): string {
  return readVersion(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}

/** Numeric semver compare; a pre-release suffix is ignored, this package never ships one. */
function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The registry's record for the latest published version. */
async function latestMeta(): Promise<Record<string, unknown>> {
  const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const meta: unknown = await res.json();
  if (typeof meta !== "object" || meta === null) throw new Error("registry sent no metadata");
  return meta as Record<string, unknown>;
}

/**
 * Replace ~/.gitstats/cli with the latest published package. The schedule points at an absolute
 * path inside it and the config lives beside it, so neither is touched.
 * No npm: the scheduler starts the job with a minimal PATH that has node (by absolute path) but
 * not npm, so the tarball is fetched directly and checked against the registry's sha512 integrity.
 */
async function update(meta: Record<string, unknown>): Promise<void> {
  const before = installedVersion();
  const dist = typeof meta.dist === "object" && meta.dist !== null ? (meta.dist as Record<string, unknown>) : {};
  const { tarball, integrity } = dist;
  if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error("registry sent no tarball or sha512 integrity");
  }
  const res = await fetch(tarball, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`could not download ${PKG}@${String(meta.version)} — registry answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash("sha512").update(bytes).digest("base64") !== integrity.slice("sha512-".length)) {
    throw new Error("the download does not match the registry's integrity hash; nothing was changed");
  }
  const tmp = mkdtempSync(join(tmpdir(), "gitstats-update-"));
  try {
    writeFileSync(join(tmp, "package.tgz"), bytes);
    // Unpack first: only replace the installed copy once we know the download is good. Relative names
    // under cwd, because GNU tar (Git for Windows) reads "C:\..." as a remote host.
    const untar = spawnSync("tar", ["-xzf", "package.tgz"], { cwd: tmp, timeout: 60_000 });
    if (untar.status !== 0) throw new Error("could not unpack the download (is tar available?)");
    const root = join(tmp, "package");
    if (!existsSync(join(root, "dist", "cli.js"))) throw new Error("the published package has no dist/cli.js");
    rmSync(join(SELF, "dist"), { recursive: true, force: true });
    mkdirSync(SELF, { recursive: true });
    cpSync(join(root, "dist"), join(SELF, "dist"), { recursive: true });
    cpSync(join(root, "package.json"), join(SELF, "package.json"));
    writeShim();
    log(`updated ${before} → ${installedVersion()} · config and schedule untouched`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Asks the registry for a newer version at most once a day, installs it and restarts the sync under
 * it. Nothing here may fail a sync: offline, a registry error or a bad download is one log line and
 * the current version carries on. `--no-update` skips the check entirely.
 * Returns the exit code of the restarted sync, or null when this process should carry on itself.
 */
async function selfUpdate(c: Config): Promise<number | null> {
  if (args.includes("--no-update")) return null;
  const last = c.lastUpdateCheck ? Date.parse(c.lastUpdateCheck) : 0;
  if (Number.isFinite(last) && Date.now() - last < UPDATE_EVERY_MS) return null;
  // Stamped before the fetch, so a registry that is down is retried tomorrow and not every sync.
  c.lastUpdateCheck = new Date().toISOString();
  saveConfig(c);
  const current = runningVersion();
  try {
    const meta = await latestMeta();
    if (typeof meta.version !== "string") throw new Error("registry sent no version");
    if (!isNewer(meta.version, current)) return null;
    await update(meta);
    const fresh = spawnSync(process.execPath, [join(SELF, "dist", "cli.js"), "sync", "--quiet"], { stdio: "inherit" });
    return fresh.status ?? 1;
  } catch (e) {
    logFile(`update check failed (${e instanceof Error ? e.message : String(e)}); staying on ${current}`);
    return null;
  }
}

/** One machine can hold several installs — a second HOME, a container, a test run. Keying the
 *  scheduler entry on the config directory keeps each one to its own job: before 0.3.5 every
 *  install used the same name, so a `link` anywhere replaced the real machine's agent and an
 *  `unlink` removed it. */
const HASH8 = createHash("sha256").update(DIR).digest("hex").slice(0, 8);
const LABEL = `com.gitstats.sync.${HASH8}`;
const JOB = `gitstats-sync-${HASH8}`;
const PLIST = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const UNIT_DIR = join(HOME, ".config", "systemd", "user");
const TIMER = join(UNIT_DIR, `${JOB}.timer`);
/** What versions before 0.3.5 installed: one shared name for every install on the machine. */
const LEGACY_PLIST = join(HOME, "Library", "LaunchAgents", "com.gitstats.sync.plist");
const LEGACY_TIMER = join(UNIT_DIR, "gitstats-sync.timer");

/** Whether the background sync is scheduled at all — `pause` removes the entry, `resume` puts it back. */
function scheduleInstalled(): boolean {
  const os = platform();
  if (os === "darwin") return existsSync(PLIST) || existsSync(LEGACY_PLIST);
  if (os === "win32") return [JOB, "gitstats-sync"].some((t) => spawnSync("schtasks", ["/Query", "/TN", t], { stdio: "ignore" }).status === 0);
  return existsSync(TIMER) || existsSync(LEGACY_TIMER);
}

/**
 * Drop a pre-0.3.5 entry so it cannot run alongside the hashed one. On macOS and Linux the entry is
 * a file under this HOME, so a run under another HOME finds nothing and leaves the real machine's
 * job alone; on Windows the task belongs to the signed-in account either way.
 */
function removeLegacySchedule(): void {
  const os = platform();
  if (os === "darwin") {
    if (!existsSync(LEGACY_PLIST)) return;
    spawnSync("launchctl", ["unload", LEGACY_PLIST], { stdio: "ignore" });
    rmSync(LEGACY_PLIST, { force: true });
  } else if (os === "win32") {
    spawnSync("schtasks", ["/Delete", "/TN", "gitstats-sync", "/F"], { stdio: "ignore" });
  } else {
    if (!existsSync(LEGACY_TIMER)) return;
    spawnSync("systemctl", ["--user", "disable", "--now", "gitstats-sync.timer"], { stdio: "ignore" });
    rmSync(LEGACY_TIMER, { force: true });
    rmSync(join(UNIT_DIR, "gitstats-sync.service"), { force: true });
  }
}

function installSchedule(): string {
  const script = installSelf();
  const node = process.execPath;
  const os = platform();
  removeLegacySchedule();
  if (os === "darwin") {
    const plist = PLIST;
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>sync</string><string>--quiet</string></array>
  <key>EnvironmentVariables</key><dict><key>GITSTATS_HOME</key><string>${HOME}</string></dict>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(DIR, "sync.log")}</string>
  <key>StandardErrorPath</key><string>${join(DIR, "sync.log")}</string>
</dict></plist>
`);
    spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
    spawnSync("launchctl", ["load", plist], { stdio: "ignore" });
    return `launchd agent ${LABEL} (every 6h, and at login)`;
  }
  if (os === "win32") {
    // Task Scheduler runs the task as the account that registered it, so its profile is already the
    // one this config lives under; there is no second HOME to carry.
    const ps = `$a = New-ScheduledTaskAction -Execute '${node}' -Argument '"${script}" sync --quiet'; ` +
      `$t = New-ScheduledTaskTrigger -Daily -At 12:00; ` +
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable; ` +
      `Register-ScheduledTask -TaskName '${JOB}' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
    spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    return `Task Scheduler task ${JOB} (daily 12:00, runs late if missed)`;
  }
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(join(UNIT_DIR, `${JOB}.service`), `[Unit]\nDescription=gitstats sync\n\n[Service]\nType=oneshot\nEnvironment=GITSTATS_HOME=${HOME}\nExecStart=${node} ${script} sync --quiet\n`);
  writeFileSync(TIMER, `[Unit]\nDescription=gitstats daily sync\n\n[Timer]\nOnCalendar=daily\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  spawnSync("systemctl", ["--user", "enable", "--now", `${JOB}.timer`], { stdio: "ignore" });
  return `systemd user timer ${JOB} (daily, catches up if missed)`;
}

function removeSchedule(): void {
  const os = platform();
  if (os === "darwin") {
    spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
    rmSync(PLIST, { force: true });
  } else if (os === "win32") {
    spawnSync("schtasks", ["/Delete", "/TN", JOB, "/F"], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", `${JOB}.timer`], { stdio: "ignore" });
    rmSync(TIMER, { force: true });
    rmSync(join(UNIT_DIR, `${JOB}.service`), { force: true });
  }
  // A machine that paused or unlinked before upgrading still has the old entry; leaving it behind
  // would keep syncing after the user asked it to stop.
  removeLegacySchedule();
}

function openBrowser(url: string): void {
  const os = platform();
  const [bin, a] = os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawnSync(bin, a, { stdio: "ignore" });
}

// ---------- commands ----------

async function revokeOnServer(server: string, token: string): Promise<boolean> {
  const res = await fetch(`${server}/api/cli/unlink`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  return res?.ok ?? false;
}

async function link(): Promise<void> {
  const server = (args.includes("--server") ? args[args.indexOf("--server") + 1] : undefined) ?? DEFAULT_SERVER;
  const expect = args.includes("--user") ? args[args.indexOf("--user") + 1] : undefined;
  log(`\n  Pairing with ${server}. The browser will ask you to confirm as the GitHub account you are signed in with there.`);
  if (expect) log(`  Expecting ${expect}; anything else is refused.`);
  const previous = loadConfig();
  if (previous) {
    log(`  this computer is already linked as ${previous.login}; replacing the link${(await revokeOnServer(previous.server, previous.token)) ? " (old one revoked)" : ""}`);
  }
  const machine = hostname();
  const start = await post<{ code: string; pollSecret: string; verifyUrl: string; expiresIn: number }>(server, "/api/cli/device", { machine });
  if (start.status !== 200 || !start.body) throw new Error(`could not reach ${server} (HTTP ${start.status})`);
  log(`\n  Open this page and confirm:  ${start.body.verifyUrl}`);
  log(`  Code: ${start.body.code}\n`);
  openBrowser(start.body.verifyUrl);
  const deadline = Date.now() + start.body.expiresIn * 1000;
  let done: { token: string; login: string; githubId: number | null; salt: string } | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const p = await post<{ status: string; token?: string; login?: string; githubId?: number | null; salt?: string }>(server, "/api/cli/device/poll", { pollSecret: start.body.pollSecret });
    if (p.status === 410) throw new Error("the code expired; run link again");
    if (p.body?.status === "ok" && p.body.token && p.body.login && p.body.salt) {
      done = { token: p.body.token, login: p.body.login, githubId: p.body.githubId ?? null, salt: p.body.salt };
      break;
    }
  }
  if (!done) throw new Error("timed out waiting for confirmation");
  log(`\n  linked as ${done.login}`);
  // The browser may have been signed in as somebody else entirely; `--user` is the only way to say
  // up front whose board this machine belongs on, so a mismatch revokes rather than reports.
  if (expect && expect.toLowerCase() !== done.login.toLowerCase()) {
    const revoked = await revokeOnServer(server, done.token);
    throw new Error(`confirmed as ${done.login}, not ${expect} — nothing was linked${revoked ? " and the pairing was revoked" : "; revoke this computer on the settings page"}. Sign in as ${expect} in the browser, then run link again.`);
  }
  const emails = new Set<string>();
  const ge = globalEmail();
  if (ge) emails.add(ge);
  if (done.githubId !== null) emails.add(`${done.githubId}+${done.login}@users.noreply.github.com`);
  const roots = args.flatMap((a, i) => (a === "--root" && args[i + 1] ? [resolve(args[i + 1]!)] : []));
  const c: Config = {
    server,
    token: done.token,
    salt: done.salt,
    sendNames: false,
    login: done.login,
    githubId: done.githubId,
    machine,
    roots: roots.length > 0 ? roots : [HOME],
    repos: [],
    emails: [...emails],
  };
  saveConfig(c);
  log(`  counting commits by: ${[...emails].join(", ") || "(no email found; run: gitstats emails add you@example.com)"}`);
  log(`  scanning ${c.roots.join(", ")} for git repos… (this first run can take a minute)\n`);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const { scanned, reports } = count(c, since, !args.includes("--no-fetch"), true, true);
  log(`  found ${scanned} repos, ${reports.length} with your commits (each one's full history this first time):`);
  summarize(reports);
  log(`\n  What gets sent per repo: a keyed hash of its remote URL, the language guess, the weekly numbers above, and commits-per-day counts.`);
  log(`  Repo names are NOT sent (turn on later with: gitstats names on).`);
  if (!args.includes("--yes") && !(await confirm("  Upload these numbers to your gitstats profile?"))) {
    rmSync(DIR, { recursive: true, force: true });
    log("  cancelled; nothing was uploaded and the link was removed locally (revoke it on the settings page).");
    return;
  }
  const body = await upload(c, reports);
  log(`  uploaded ${body.weeks} weekly rows for ${body.repos} repos in ${body.requests} request${body.requests === 1 ? "" : "s"}${body.historyLeft > 0 ? `; ${body.historyLeft} full histories were not accepted and go with the next sync` : ""}`);
  const how = installSchedule();
  log(`\n  scheduled: ${how}`);
  log(`  config: ${CONFIG}`);
  log(`\n  done. It re-syncs on its own. To run commands by hand, either use`);
  log(`    npx @yaroslavhaidash/gitstats-cli@latest <command>`);
  log(`  or add ${BIN} to your PATH and use \`gitstats <command>\`.`);
  log(`  Commands and how to stop: ${server}/docs\n`);
}

/**
 * What `link` would count, printed and then forgotten. It talks to git and to nothing else: no
 * pairing, no upload, no config file, and no network unless `--fetch` is asked for. The point is
 * that the answer to "what would this send?" can be had without having to trust the answer.
 */
function stats(): void {
  const roots = args.flatMap((a, i) => (a === "--root" && args[i + 1] ? [resolve(args[i + 1]!)] : []));
  const given = args.flatMap((a, i) => (a === "--email" && args[i + 1] ? [args[i + 1]!] : []));
  // `link` also counts the GitHub noreply address, but that needs the account id a pairing returns.
  const global = globalEmail();
  const emails = given.length > 0 ? given : global ? [global] : [];
  // Never written anywhere: the salt only exists because `countRepo` hashes a remote it will not send.
  const c: Config = {
    server: DEFAULT_SERVER,
    token: "",
    salt: randomBytes(16).toString("hex"),
    sendNames: false,
    login: "",
    githubId: null,
    machine: hostname(),
    roots: roots.length > 0 ? roots : [HOME],
    repos: [],
    emails,
  };
  log(`  counting commits by: ${[...c.emails, "each repo's own user.email"].join(", ")}`);
  log(`  scanning ${c.roots.join(", ")} for git repos… nothing is uploaded and no config is written\n`);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const { scanned, reports } = count(c, since, args.includes("--fetch"));
  log(`  found ${scanned} repos, ${reports.length} with your commits in the last year:\n`);
  if (reports.length === 0) {
    log(emails.length > 0 ? "  nothing in the last year. Repos elsewhere? add --root /path" : "  no commit email found — pass --email you@example.com");
    return;
  }
  summarize(reports);
  const all = reports.flatMap((r) => r.weeks);
  const commits = all.reduce((n, w) => n + w.commits, 0);
  const additions = all.reduce((n, w) => n + w.additions, 0);
  const deletions = all.reduce((n, w) => n + w.deletions, 0);
  const days = new Set(reports.flatMap((r) => r.days.filter((d) => d.commits > 0).map((d) => d.date))).size;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  log(`\n  last ${DAYS} days: ${plural(commits, "commit")}, +${additions} −${deletions} lines, ${plural(reports.length, "repo")}, ${plural(days, "active day")}`);
  log(`  nothing was sent · after \`link\` these numbers go to your page on ${DEFAULT_SERVER.replace("https://", "")}`);
}

function requireConfig(): Config {
  const c = loadConfig();
  if (!c) throw new Error("not linked yet; run: npx @yaroslavhaidash/gitstats-cli@latest link");
  return c;
}

async function main(): Promise<void> {
  switch (cmd) {
    case "link":
      return link();
    case "sync":
      return sync(requireConfig(), args.includes("--quiet"));
    case "stats":
      return stats();
    case "status": {
      const c = requireConfig();
      // Labels are padded to the width of `last sync`, the longest one.
      log(`server    ${c.server}\nuser      ${c.login}\nmachine   ${c.machine}\nversion   ${installedVersion()}\nroots     ${c.roots.join(", ")}\nextra     ${c.repos.join(", ") || "-"}\nemails    ${c.emails.join(", ")}`);
      log(`schedule  ${scheduleInstalled() ? "scheduled" : "paused \u00b7 `gitstats resume` starts it again"}`);
      log(c.lastSync ? `last sync ${c.lastSync.at} · ${c.lastSync.repos} repos · ${c.lastSync.weeks} weeks${c.lastSync.error ? ` · ERROR ${c.lastSync.error}` : ""}` : "last sync never");
      return;
    }
    case "add": {
      const c = requireConfig();
      const p = resolve(args[1] ?? ".");
      if (!existsSync(join(p, ".git"))) throw new Error(`${p} is not a git repo`);
      if (!c.repos.includes(p)) c.repos.push(p);
      saveConfig(c);
      log(`tracking ${p}`);
      return sync(c);
    }
    case "roots": {
      const c = requireConfig();
      const d = args[2];
      if (args[1] === "add" && d) {
        const p = resolve(d);
        if (!c.roots.includes(p)) c.roots.push(p);
        saveConfig(c);
        log(`roots: ${c.roots.join(", ")}`);
        return sync(c);
      }
      log(`roots: ${c.roots.join(", ")}`);
      return;
    }
    case "emails": {
      const c = requireConfig();
      const e = args[2];
      if (args[1] === "add" && e) {
        if (!c.emails.includes(e)) c.emails.push(e);
        saveConfig(c);
        log(`emails: ${c.emails.join(", ")}`);
        return sync(c);
      }
      log(`emails: ${c.emails.join(", ")}`);
      return;
    }
    case "names": {
      const c = requireConfig();
      if (args[1] === "on" || args[1] === "off") {
        c.sendNames = args[1] === "on";
        saveConfig(c);
        log(`repo names: ${c.sendNames ? "sent (others see them only if your settings allow)" : "not sent"}`);
        return sync(c);
      }
      log(`repo names: ${c.sendNames ? "sent" : "not sent"}`);
      return;
    }
    case "pause":
      requireConfig();
      removeSchedule();
      log("background sync stopped; `gitstats resume` starts it again, `gitstats sync` still works by hand");
      return;
    case "resume":
      requireConfig();
      log(`background sync: ${installSchedule()}`);
      return;
    case "update":
      requireConfig();
      return update(await latestMeta());
    case "unlink": {
      const c = loadConfig();
      removeSchedule();
      if (c) log((await revokeOnServer(c.server, c.token)) ? "revoked on the server" : "could not reach the server; revoke this computer on the settings page");
      rmSync(DIR, { recursive: true, force: true });
      log("unlinked");
      return;
    }
    default:
      log("usage: gitstats <link [--user <login>] [--root <dir>]... [--yes] | stats [--root <dir>]... [--fetch] | sync [--history] [--no-fetch] [--no-update] | status | add <path> | roots add <dir> | emails add <email> | names on|off | pause | resume | update | unlink>");
  }
}

main().catch((e: unknown) => {
  console.error(`gitstats: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
