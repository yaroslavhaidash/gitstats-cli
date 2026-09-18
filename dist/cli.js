#!/usr/bin/env node
/**
 * gitstats CLI — counts commits and lines in the git repos on this machine and sends ONLY the
 * numbers (per repo, per week) to your gitstats profile. No file contents, no diffs, no GitHub tokens.
 *
 *   npx gitstats-cli link     pair this computer, scan for repos, sync, install a daily sync
 *   gitstats sync             fetch each repo's default branch, recount the last year, upload (idempotent; --no-fetch to skip)
 *   gitstats status           show what is linked and when it last ran
 *   gitstats add <path>       track a repo outside the scanned folders
 *   gitstats roots add <dir>  scan another folder (e.g. one outside your home directory)
 *   gitstats emails add <e>   attribute commits made with another email to you
 *   gitstats names on|off     also send repo names (off by default; your own page then labels private repos by hash)
 *   gitstats pause | resume   stop / restart the background sync without unlinking
 *   gitstats unlink           revoke this computer and remove the schedule and local config
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_SERVER = "https://gitstats-three-zeta.vercel.app";
const HOME = homedir();
const DIR = join(HOME, ".gitstats");
const CONFIG = join(DIR, "config.json");
const SELF = join(DIR, "cli");
const DAYS = 365;
const SKIP_DIRS = new Set(["node_modules", "Library", "Applications", ".Trash", "vendor", "target", "build", "dist", ".venv", "venv", "__pycache__", "Pods", "DerivedData", "go", ".cargo", ".rustup", ".npm", ".cache", ".local", "snap", "AppData"]);
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
function log(msg) {
    console.log(msg);
}
function loadConfig() {
    if (!existsSync(CONFIG))
        return null;
    return JSON.parse(readFileSync(CONFIG, "utf8"));
}
function saveConfig(c) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}
function git(cwd, ...a) {
    const r = spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
}
function globalEmail() {
    const r = spawnSync("git", ["config", "--global", "user.email"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() || null : null;
}
// ---------- repo discovery ----------
function isWorktree(repo) {
    try {
        return statSync(join(repo, ".git")).isFile();
    }
    catch {
        return false;
    }
}
function findRepos(roots, explicit) {
    const found = new Set(explicit.filter((p) => existsSync(join(p, ".git"))));
    const walk = (dir, depth) => {
        if (depth > 5)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        if (entries.includes(".git")) {
            found.add(dir);
            return;
        }
        for (const e of entries) {
            if (SKIP_DIRS.has(e) || (e.startsWith(".") && depth > 0))
                continue;
            const p = join(dir, e);
            try {
                if (statSync(p).isDirectory())
                    walk(p, depth + 1);
            }
            catch {
                /* unreadable, skip */
            }
        }
    };
    for (const r of roots)
        walk(r, 0);
    // Real clones before worktrees, so the dedupe below keeps the primary checkout.
    return [...found].sort((a, b) => Number(isWorktree(a)) - Number(isWorktree(b)) || a.localeCompare(b));
}
/** `remote:github.com/owner/name` (lower-cased, no protocol/user/.git) or `path:<dir>` when there is no remote. */
function remoteInfo(repo) {
    const raw = git(repo, "config", "--get", "remote.origin.url")?.trim();
    if (!raw)
        return { key: `path:${repo}`, label: basename(repo) };
    const norm = raw.replace(/^git@([^:]+):/, "$1/").replace(/^[a-z]+:\/\//, "").replace(/^[^@]+@/, "").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
    return { key: `remote:${norm}`, label: norm.split("/").slice(-2).join("/") || basename(repo) };
}
/**
 * Refresh origin's default branch so commits pushed from other machines are counted here too.
 * Quiet, no credential prompts, bounded; a failure just means we count what is already local.
 */
function refresh(repo, ref) {
    if (!ref.startsWith("origin/"))
        return;
    spawnSync("git", ["fetch", "-q", "origin", ref.slice("origin/".length)], {
        cwd: repo,
        stdio: "ignore",
        timeout: 20_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    });
}
function defaultRef(repo) {
    const head = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")?.trim();
    if (head)
        return head;
    for (const ref of ["origin/main", "origin/master", "main", "master"]) {
        if (git(repo, "rev-parse", "--verify", "-q", ref) !== null)
            return ref;
    }
    return "HEAD";
}
// ---------- counting ----------
const LANG = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
    py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", swift: "Swift", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C",
    php: "PHP", html: "HTML", css: "CSS", scss: "SCSS", vue: "Vue", svelte: "Svelte", dart: "Dart", scala: "Scala", ex: "Elixir", exs: "Elixir",
    sql: "SQL", sh: "Shell", zsh: "Shell", lua: "Lua", r: "R", m: "Objective-C", hs: "Haskell", clj: "Clojure", elm: "Elm", tf: "HCL",
};
const NOISE = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum"]);
/** Sunday 00:00 UTC of the week containing `d`, as YYYY-MM-DD — same bucketing as GitHub's stats/contributors. */
function weekStartUtc(d) {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()));
    return s.toISOString().slice(0, 10);
}
/** Read one `git log --numstat` run into week and day buckets. Same rules for merged and pending work. */
function tally(out, all) {
    const weeks = new Map();
    const days = new Map();
    const langLines = new Map();
    for (const rec of out.split("\x1e").slice(1)) {
        const [header, ...lines] = rec.split("\n");
        const [, dateStr, authorEmail] = header?.split("\x1f") ?? [];
        // --author is a substring match; keep only exact email matches.
        if (!dateStr || !authorEmail || !all.some((e) => e.toLowerCase() === authorEmail.toLowerCase()))
            continue;
        const when = new Date(dateStr);
        const ws = weekStartUtc(when);
        const w = weeks.get(ws) ?? { weekStart: ws, additions: 0, deletions: 0, commits: 0 };
        w.commits += 1;
        const date = when.toISOString().slice(0, 10);
        const day = days.get(date) ?? { date, additions: 0, deletions: 0, commits: 0 };
        day.commits += 1;
        for (const l of lines) {
            const [a, d, path] = l.split("\t");
            if (!a || !d || !path || a === "-" || d === "-")
                continue;
            w.additions += Number(a);
            w.deletions += Number(d);
            day.additions += Number(a);
            day.deletions += Number(d);
            const file = basename(path);
            const ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "";
            const lang = LANG[ext];
            if (lang && !NOISE.has(file))
                langLines.set(lang, (langLines.get(lang) ?? 0) + Number(a) + Number(d));
        }
        weeks.set(ws, w);
        days.set(date, day);
    }
    return { weeks, days, langLines };
}
function buckets(t) {
    return {
        weeks: [...t.weeks.values()].sort((x, y) => x.weekStart.localeCompare(y.weekStart)),
        days: [...t.days.values()].sort((x, y) => x.date.localeCompare(y.date)),
    };
}
const EMPTY_TALLY = () => ({ weeks: new Map(), days: new Map(), langLines: new Map() });
function countRepo(repo, emails, since, salt, sendNames, fetch) {
    const info = remoteInfo(repo);
    const localEmail = git(repo, "config", "user.email")?.trim();
    const all = [...new Set([...emails, ...(localEmail ? [localEmail] : [])])].filter(Boolean);
    if (all.length === 0)
        return null;
    const ref = defaultRef(repo);
    if (fetch)
        refresh(repo, ref);
    // --fixed-strings: emails like 123+login@users.noreply.github.com would otherwise be read as regex.
    const common = ["--no-merges", "--fixed-strings", `--since=${since}`, "--numstat", "--date=iso-strict", "--format=%x1e%H%x1f%aI%x1f%ae"];
    const authors = all.map((e) => `--author=${e}`);
    const out = git(repo, "log", ref, ...common, ...authors);
    if (out === null)
        return null;
    // Everything on any other local or remote branch that the default branch has not taken in yet.
    const pendingOut = git(repo, "log", "--all", "--not", ref, ...common, ...authors);
    const merged = tally(out, all);
    const pending = pendingOut === null ? EMPTY_TALLY() : tally(pendingOut, all);
    if (merged.weeks.size === 0 && pending.weeks.size === 0)
        return null;
    const langLines = merged.langLines.size > 0 ? merged.langLines : pending.langLines;
    const language = [...langLines.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return {
        remoteHash: createHmac("sha256", salt).update(info.key).digest("hex"),
        name: sendNames ? info.label : null,
        language,
        ...buckets(merged),
        pending: buckets(pending),
        path: repo,
        label: info.label,
        isWorktree: isWorktree(repo),
    };
}
// ---------- server ----------
async function post(server, path, body, token) {
    const res = await fetch(`${server}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        /* non-JSON error body */
    }
    return { status: res.status, body: parsed };
}
function summarize(reports) {
    for (const r of reports) {
        const a = r.weeks.reduce((n, w) => n + w.additions, 0);
        const d = r.weeks.reduce((n, w) => n + w.deletions, 0);
        const cm = r.weeks.reduce((n, w) => n + w.commits, 0);
        const pending = r.pending.weeks.reduce((n, w) => n + w.commits, 0);
        log(`  ${r.label.padEnd(40)} ${String(cm).padStart(5)} commits  +${a} −${d}${pending > 0 ? `  (${pending} pending)` : ""}`);
    }
}
async function confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    rl.close();
    return answer === "" || answer === "y" || answer === "yes";
}
function count(c, since) {
    const repos = findRepos(c.roots, c.repos);
    const reports = [];
    const seen = new Set();
    const fetch = !args.includes("--no-fetch");
    for (const r of repos) {
        // Worktrees and extra clones share a remote: fetch and count the primary clone only (they read the same origin/HEAD).
        const key = remoteInfo(r).key;
        if (seen.has(key))
            continue;
        seen.add(key);
        const rep = countRepo(r, c.emails, since, c.salt, c.sendNames, fetch);
        if (rep)
            reports.push(rep);
    }
    return { scanned: repos.length, reports };
}
async function upload(c, reports) {
    const payload = reports.map(({ remoteHash, name, language, weeks, days, pending }) => ({ remoteHash, name, language, weeks, days, pending }));
    const { status, body } = await post(c.server, "/api/ingest", { repos: payload }, c.token);
    if (status !== 200 || !body) {
        c.lastSync = { at: new Date().toISOString(), repos: 0, weeks: 0, error: `server answered ${status}` };
        saveConfig(c);
        throw new Error(status === 401 ? "this computer is no longer linked; run `gitstats link` again" : `sync failed: HTTP ${status}`);
    }
    c.lastSync = { at: new Date().toISOString(), repos: body.repos, weeks: body.weeks };
    saveConfig(c);
    return body;
}
async function sync(c, quiet = false) {
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
    const { scanned, reports } = count(c, since);
    const body = await upload(c, reports);
    if (!quiet) {
        log(`scanned ${scanned} repos, ${reports.length} with your commits in the last year, ${body.weeks} weekly rows sent`);
        summarize(reports);
    }
}
// ---------- scheduler ----------
const BIN = join(DIR, "bin");
function installSelf() {
    const here = dirname(fileURLToPath(import.meta.url)); // .../dist
    const pkgRoot = resolve(here, "..");
    rmSync(SELF, { recursive: true, force: true });
    mkdirSync(SELF, { recursive: true });
    cpSync(join(pkgRoot, "dist"), join(SELF, "dist"), { recursive: true });
    cpSync(join(pkgRoot, "package.json"), join(SELF, "package.json"));
    const script = join(SELF, "dist", "cli.js");
    // A `gitstats` command for shells that have ~/.gitstats/bin on PATH; npx form works regardless.
    mkdirSync(BIN, { recursive: true });
    if (platform() === "win32") {
        writeFileSync(join(BIN, "gitstats.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    }
    else {
        writeFileSync(join(BIN, "gitstats"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    return script;
}
function installSchedule() {
    const script = installSelf();
    const node = process.execPath;
    const os = platform();
    if (os === "darwin") {
        const plist = join(HOME, "Library", "LaunchAgents", "com.gitstats.sync.plist");
        mkdirSync(dirname(plist), { recursive: true });
        writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gitstats.sync</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>sync</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(DIR, "sync.log")}</string>
  <key>StandardErrorPath</key><string>${join(DIR, "sync.log")}</string>
</dict></plist>
`);
        spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
        spawnSync("launchctl", ["load", plist], { stdio: "ignore" });
        return "launchd agent com.gitstats.sync (every 6h, and at login)";
    }
    if (os === "win32") {
        const ps = `$a = New-ScheduledTaskAction -Execute '${node}' -Argument '"${script}" sync --quiet'; ` +
            `$t = New-ScheduledTaskTrigger -Daily -At 12:00; ` +
            `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable; ` +
            `Register-ScheduledTask -TaskName 'gitstats-sync' -Action $a -Trigger $t -Settings $s -Force | Out-Null`;
        spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
        return "Task Scheduler task gitstats-sync (daily 12:00, runs late if missed)";
    }
    const unitDir = join(HOME, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "gitstats-sync.service"), `[Unit]\nDescription=gitstats sync\n\n[Service]\nType=oneshot\nExecStart=${node} ${script} sync --quiet\n`);
    writeFileSync(join(unitDir, "gitstats-sync.timer"), `[Unit]\nDescription=gitstats daily sync\n\n[Timer]\nOnCalendar=daily\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "enable", "--now", "gitstats-sync.timer"], { stdio: "ignore" });
    return "systemd user timer gitstats-sync (daily, catches up if missed)";
}
function removeSchedule() {
    const os = platform();
    if (os === "darwin") {
        const plist = join(HOME, "Library", "LaunchAgents", "com.gitstats.sync.plist");
        spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
        rmSync(plist, { force: true });
    }
    else if (os === "win32") {
        spawnSync("schtasks", ["/Delete", "/TN", "gitstats-sync", "/F"], { stdio: "ignore" });
    }
    else {
        spawnSync("systemctl", ["--user", "disable", "--now", "gitstats-sync.timer"], { stdio: "ignore" });
        rmSync(join(HOME, ".config", "systemd", "user", "gitstats-sync.timer"), { force: true });
        rmSync(join(HOME, ".config", "systemd", "user", "gitstats-sync.service"), { force: true });
    }
}
function openBrowser(url) {
    const os = platform();
    const [bin, a] = os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    spawnSync(bin, a, { stdio: "ignore" });
}
// ---------- commands ----------
async function revokeOnServer(c) {
    const res = await fetch(`${c.server}/api/cli/unlink`, { method: "DELETE", headers: { Authorization: `Bearer ${c.token}` } }).catch(() => null);
    return res?.ok ?? false;
}
async function link() {
    const server = (args.includes("--server") ? args[args.indexOf("--server") + 1] : undefined) ?? DEFAULT_SERVER;
    const previous = loadConfig();
    if (previous) {
        log(`  this computer is already linked as ${previous.login}; replacing the link${(await revokeOnServer(previous)) ? " (old one revoked)" : ""}`);
    }
    const machine = hostname();
    const start = await post(server, "/api/cli/device", { machine });
    if (start.status !== 200 || !start.body)
        throw new Error(`could not reach ${server} (HTTP ${start.status})`);
    log(`\n  Open this page and confirm:  ${start.body.verifyUrl}`);
    log(`  Code: ${start.body.code}\n`);
    openBrowser(start.body.verifyUrl);
    const deadline = Date.now() + start.body.expiresIn * 1000;
    let done = null;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const p = await post(server, "/api/cli/device/poll", { pollSecret: start.body.pollSecret });
        if (p.status === 410)
            throw new Error("the code expired; run link again");
        if (p.body?.status === "ok" && p.body.token && p.body.login && p.body.salt) {
            done = { token: p.body.token, login: p.body.login, githubId: p.body.githubId ?? null, salt: p.body.salt };
            break;
        }
    }
    if (!done)
        throw new Error("timed out waiting for confirmation");
    const emails = new Set();
    const ge = globalEmail();
    if (ge)
        emails.add(ge);
    if (done.githubId !== null)
        emails.add(`${done.githubId}+${done.login}@users.noreply.github.com`);
    const roots = args.flatMap((a, i) => (a === "--root" && args[i + 1] ? [resolve(args[i + 1])] : []));
    const c = {
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
    log(`  linked as ${done.login} · counting commits by: ${[...emails].join(", ") || "(no email found; run: gitstats emails add you@example.com)"}`);
    log(`  scanning ${c.roots.join(", ")} for git repos… (this first run can take a minute)\n`);
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
    const { scanned, reports } = count(c, since);
    log(`  found ${scanned} repos, ${reports.length} with your commits in the last year:`);
    summarize(reports);
    log(`\n  What gets sent per repo: a keyed hash of its remote URL, the language guess, the weekly numbers above, and commits-per-day counts.`);
    log(`  Repo names are NOT sent (turn on later with: gitstats names on).`);
    if (!args.includes("--yes") && !(await confirm("  Upload these numbers to your gitstats profile?"))) {
        rmSync(DIR, { recursive: true, force: true });
        log("  cancelled; nothing was uploaded and the link was removed locally (revoke it on the settings page).");
        return;
    }
    const body = await upload(c, reports);
    log(`  uploaded ${body.weeks} weekly rows for ${body.repos} repos`);
    const how = installSchedule();
    log(`\n  scheduled: ${how}`);
    log(`  config: ${CONFIG}`);
    log(`\n  done. It re-syncs on its own. To run commands by hand, either use`);
    log(`    npx --yes github:yaroslavhaidash/gitstats-cli <command>`);
    log(`  or add ${BIN} to your PATH and use \`gitstats <command>\`.`);
    log(`  Commands and how to stop: ${server}/docs\n`);
}
function requireConfig() {
    const c = loadConfig();
    if (!c)
        throw new Error("not linked yet; run: npx gitstats-cli link");
    return c;
}
async function main() {
    switch (cmd) {
        case "link":
            return link();
        case "sync":
            return sync(requireConfig(), args.includes("--quiet"));
        case "status": {
            const c = requireConfig();
            log(`server   ${c.server}\nuser     ${c.login}\nmachine  ${c.machine}\nroots    ${c.roots.join(", ")}\nextra    ${c.repos.join(", ") || "-"}\nemails   ${c.emails.join(", ")}`);
            log(c.lastSync ? `last sync ${c.lastSync.at} · ${c.lastSync.repos} repos · ${c.lastSync.weeks} weeks${c.lastSync.error ? ` · ERROR ${c.lastSync.error}` : ""}` : "last sync never");
            return;
        }
        case "add": {
            const c = requireConfig();
            const p = resolve(args[1] ?? ".");
            if (!existsSync(join(p, ".git")))
                throw new Error(`${p} is not a git repo`);
            if (!c.repos.includes(p))
                c.repos.push(p);
            saveConfig(c);
            log(`tracking ${p}`);
            return sync(c);
        }
        case "roots": {
            const c = requireConfig();
            const d = args[2];
            if (args[1] === "add" && d) {
                const p = resolve(d);
                if (!c.roots.includes(p))
                    c.roots.push(p);
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
                if (!c.emails.includes(e))
                    c.emails.push(e);
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
        case "unlink": {
            const c = loadConfig();
            removeSchedule();
            if (c)
                log((await revokeOnServer(c)) ? "revoked on the server" : "could not reach the server; revoke this computer on the settings page");
            rmSync(DIR, { recursive: true, force: true });
            log("unlinked");
            return;
        }
        default:
            log("usage: gitstats <link [--root <dir>]... [--yes] | sync | status | add <path> | roots add <dir> | emails add <email> | names on|off | pause | resume | unlink>");
    }
}
main().catch((e) => {
    console.error(`gitstats: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
