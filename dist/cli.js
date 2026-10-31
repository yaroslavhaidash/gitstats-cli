#!/usr/bin/env node
/**
 * gitstats CLI — counts commits and lines in the git repos on this machine and sends ONLY the
 * numbers (per repo, per week) to your gitstats profile. No file contents, no diffs, no GitHub tokens.
 *
 *   npx @yaroslavhaidash/gitstats-cli@latest link
 *                             pair this computer, scan for repos, sync, install a daily sync
 *                             (--user <login> refuses the pairing if the browser confirms as someone else;
 *                             --claude also counts Claude Code usage without asking)
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
 *   gitstats claude on|off    also send Claude Code usage: tokens per UTC day per model, numbers only (off by default)
 *   gitstats claude           print the last 14 days of Claude Code usage from this machine's logs; sends nothing
 *   gitstats pause | resume   stop / restart the background sync without unlinking
 *   gitstats update           fetch the latest published version now (sync does this on its own, once a day)
 *   gitstats unlink           revoke this computer and remove the schedule and local config
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createInterface as lineReader } from "node:readline";
import { createInterface } from "node:readline/promises";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
function log(msg) {
    console.log(msg);
}
/** Background runs already redirect their output here; a manual run appends directly so a failed
 *  update check leaves the same trail either way. */
function logFile(msg) {
    try {
        mkdirSync(DIR, { recursive: true });
        appendFileSync(SYNC_LOG, `${new Date().toISOString()} ${msg}\n`);
    }
    catch {
        /* the log is best effort; it must never break a sync */
    }
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
/**
 * Remote branches whose work has not landed on the default branch yet. Only `refs/remotes/origin`
 * counts, and only tips touched in the last 30 days: local branches left behind by squash-merged
 * worktrees are the same commits over again, and they inflated pending by 14x.
 */
function pendingRefs(repo, ref) {
    const out = git(repo, "for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/remotes/origin");
    if (out === null)
        return [];
    const cutoff = Date.now() / 1000 - PENDING_DAYS * 86_400;
    const refs = [];
    for (const line of out.split("\n")) {
        const [name, when] = line.split(" ");
        if (!name || !when)
            continue;
        const short = name.slice("refs/remotes/".length);
        if (short === ref || short === "origin/HEAD")
            continue;
        if (Number(when) < cutoff)
            continue;
        refs.push(name);
    }
    return refs;
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
function remoteHash(salt, key) {
    return createHmac("sha256", salt).update(key).digest("hex");
}
/** `historyFrom` counts the default branch from that day instead of `since`; pending work stays at `since`. */
function countRepo(repo, emails, since, salt, sendNames, fetch, historyFrom = null) {
    const info = remoteInfo(repo);
    const localEmail = git(repo, "config", "user.email")?.trim();
    const all = [...new Set([...emails, ...(localEmail ? [localEmail] : [])])].filter(Boolean);
    if (all.length === 0)
        return null;
    const ref = defaultRef(repo);
    if (fetch)
        refresh(repo, ref);
    // --fixed-strings: emails like 123+login@users.noreply.github.com would otherwise be read as regex.
    const common = ["--no-merges", "--fixed-strings", "--numstat", "--date=iso-strict", "--format=%x1e%H%x1f%aI%x1f%ae"];
    const authors = all.map((e) => `--author=${e}`);
    const out = git(repo, "log", ref, `--since=${historyFrom ?? since}`, ...common, ...authors);
    if (out === null)
        return null;
    const unmerged = pendingRefs(repo, ref);
    const pendingOut = unmerged.length > 0 ? git(repo, "log", ...unmerged, "--not", ref, `--since=${since}`, ...common, ...authors) : null;
    const merged = tally(out, all);
    const pending = pendingOut === null ? EMPTY_TALLY() : tally(pendingOut, all);
    if (merged.weeks.size === 0 && pending.weeks.size === 0)
        return null;
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
// ---------- Claude Code usage ----------
/** The server's floor: Claude Code's first public release was in 2025, an earlier date is a clock bug. */
const CLAUDE_FROM = "2025-01-01";
/** Days recounted on every sync, so replies written late or copied into a resumed session land. */
const CLAUDE_WINDOW = 7;
/** The longest window the server accepts in one upload. */
const CLAUDE_MAX_SPAN = 1_000;
const CLAUDE_MODEL = /^[a-z0-9][a-z0-9.\-]{0,63}$/;
const CLAUDE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
function utcToday() {
    return new Date().toISOString().slice(0, 10);
}
function addDays(day, n) {
    return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Read where Claude Code itself reads; fixed into the config at `claude on` for the scheduler. */
function defaultClaudeDir() {
    return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}
/** Every transcript under `<dir>/projects`, subagents and workflows included, changed since `sinceMs`. */
function claudeFiles(dir, sinceMs) {
    const root = join(dir, "projects");
    const files = [];
    const walk = (d) => {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.isFile() && e.name.endsWith(".jsonl")) {
                try {
                    if (statSync(p).mtimeMs >= sinceMs)
                        files.push({ path: p, main: !relative(root, p).split(sep).includes("subagents") });
                }
                catch {
                    /* gone or unreadable, skip */
                }
            }
        }
    };
    walk(root);
    return files;
}
/**
 * One transcript line, if it is a reply with usage. Only these keys are looked at: type, timestamp,
 * sessionId, version, message.id, message.model and the four message.usage counts. The message
 * content, paths and tool records are never read.
 */
function claudeReply(line) {
    let rec;
    try {
        rec = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!isRecord(rec) || rec.type !== "assistant" || typeof rec.timestamp !== "string")
        return null;
    const m = rec.message;
    if (!isRecord(m) || typeof m.id !== "string" || !isRecord(m.usage))
        return null;
    const model = typeof m.model === "string" ? m.model.toLowerCase() : "";
    if (model === "<synthetic>")
        return null;
    const when = new Date(rec.timestamp);
    if (Number.isNaN(when.getTime()))
        return null;
    const n = (x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    const u = m.usage;
    const input = n(u.input_tokens);
    const output = n(u.output_tokens);
    const cacheRead = n(u.cache_read_input_tokens);
    const cacheWrite = n(u.cache_creation_input_tokens);
    if (input + output + cacheRead + cacheWrite === 0)
        return null;
    return {
        id: m.id,
        day: when.toISOString().slice(0, 10),
        model: CLAUDE_MODEL.test(model) ? model : "other",
        input,
        output,
        cacheRead,
        cacheWrite,
        session: typeof rec.sessionId === "string" ? rec.sessionId : null,
        version: typeof rec.version === "string" && CLAUDE_VERSION.test(rec.version) ? rec.version : null,
    };
}
/**
 * Tokens per UTC day per model in `[from, to]`, from transcripts changed since `sinceMs`.
 * Claude Code writes one line per content block of a reply, each with a growing `output_tokens`, and
 * copies old replies into resumed and forked sessions, so lines are deduped by message id across
 * every file read (max per field, earliest day) before anything is added up. A session counts once,
 * on the day of its first reply in a main transcript, under that reply's model.
 */
async function countClaude(dir, from, to, sinceMs) {
    const files = claudeFiles(dir, sinceMs);
    const replies = new Map();
    const sessions = new Map();
    let version = null;
    for (const f of files) {
        try {
            for await (const line of lineReader({ input: createReadStream(f.path, { encoding: "utf8" }), crlfDelay: Infinity })) {
                // The type's value is this exact string, so the cheap test cannot miss a reply.
                if (!line.includes('"assistant"'))
                    continue;
                const r = claudeReply(line);
                if (!r)
                    continue;
                const prev = replies.get(r.id);
                if (!prev) {
                    replies.set(r.id, { day: r.day, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
                }
                else {
                    prev.input = Math.max(prev.input, r.input);
                    prev.output = Math.max(prev.output, r.output);
                    prev.cacheRead = Math.max(prev.cacheRead, r.cacheRead);
                    prev.cacheWrite = Math.max(prev.cacheWrite, r.cacheWrite);
                    if (r.day < prev.day)
                        prev.day = r.day;
                }
                if (f.main && r.session !== null) {
                    const s = sessions.get(r.session);
                    if (!s || r.day < s.day)
                        sessions.set(r.session, { day: r.day, model: r.model });
                }
                if (r.version !== null && r.day >= from && r.day <= to && (version === null || isNewer(r.version, version)))
                    version = r.version;
            }
        }
        catch {
            /* unreadable file, skip */
        }
    }
    const rows = new Map();
    const row = (date, model) => {
        const key = `${date}\0${model}`;
        let d = rows.get(key);
        if (!d)
            rows.set(key, (d = { date, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, replies: 0, sessions: 0 }));
        return d;
    };
    let counted = 0;
    let firstDay = null;
    for (const r of replies.values()) {
        if (r.day < from || r.day > to)
            continue;
        const d = row(r.day, r.model);
        d.input += r.input;
        d.output += r.output;
        d.cacheRead += r.cacheRead;
        d.cacheWrite += r.cacheWrite;
        d.replies += 1;
        counted += 1;
        if (firstDay === null || r.day < firstDay)
            firstDay = r.day;
    }
    for (const s of sessions.values())
        if (s.day >= from && s.day <= to)
            row(s.day, s.model).sessions += 1;
    const days = [...rows.values()].sort((x, y) => x.date.localeCompare(y.date) || x.model.localeCompare(y.model));
    return { files: files.length, recognised: replies.size, replies: counted, days, firstDay, version };
}
/** The OS's own id for this computer, so the machine key survives `unlink`/`link` and renames. */
function platformId() {
    const run = (bin, a) => execFileSync(bin, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    try {
        const os = platform();
        if (os === "darwin")
            return /"IOPlatformUUID" = "([^"]+)"/.exec(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1] ?? null;
        if (os === "win32")
            return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]))?.[1] ?? null;
        for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
            const id = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
            if (id)
                return id;
        }
    }
    catch {
        /* no id readable: fall back below */
    }
    return null;
}
/** Keyed with the user's salt, so the server never sees the platform id or the path. */
function claudeMachine(c, cc) {
    const id = platformId() ?? (cc.fallbackId ??= randomBytes(16).toString("hex"));
    let dir = resolve(cc.dir);
    try {
        dir = realpathSync(cc.dir);
    }
    catch {
        /* keep the resolved path */
    }
    return createHmac("sha256", c.salt).update(`${id}\0${dir}`).digest("hex").slice(0, 32);
}
/**
 * The `claude` field for the first request of a sync, or null when counting is off or nothing may be
 * sent. The window is the last week, reaching back to the last accepted day after a gap; the first
 * upload counts every log Claude Code still keeps and starts at its first day. The server replaces
 * exactly `[from, to]` for this machine, so a window whose files changed but gave no reply (a log
 * format change) is not sent at all rather than wiping counted days with zeros.
 */
async function claudeUpload(c) {
    const cc = c.claude;
    if (!cc?.on)
        return null;
    const started = Date.now();
    const to = utcToday();
    const span = addDays(to, -CLAUDE_MAX_SPAN);
    const floor = span > CLAUDE_FROM ? span : CLAUDE_FROM;
    const fail = (msg) => {
        cc.lastError = msg;
        logFile(msg);
        return null;
    };
    try {
        const week = addDays(to, -CLAUDE_WINDOW);
        const caughtUp = cc.syncedThrough && addDays(cc.syncedThrough, -1) < week ? addDays(cc.syncedThrough, -1) : week;
        const recent = caughtUp < floor ? floor : caughtUp;
        const scanFrom = cc.historySent ? recent : floor;
        if (!existsSync(join(cc.dir, "projects")))
            return fail(`claude: no Claude Code logs in ${join(cc.dir, "projects")}`);
        const n = await countClaude(cc.dir, scanFrom, to, Date.parse(`${scanFrom}T00:00:00Z`));
        if (n.files > 0 && n.recognised === 0)
            return fail(`claude: no usage recognised in ${n.files} changed files; the log format may have changed`);
        const from = !cc.historySent && n.firstDay !== null && n.firstDay < recent ? n.firstDay : recent;
        const machine = claudeMachine(c, cc);
        logFile(`claude: ${from}..${to}${cc.historySent ? "" : " (full history)"}, ${n.files} files read, ${n.replies} replies, ${n.days.length} rows, ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return { machine, from, to, ...(n.version ? { version: n.version } : {}), days: n.days };
    }
    catch (e) {
        return fail(`claude: count failed (${e instanceof Error ? e.message : String(e)})`);
    }
}
/** On for `dir`: the same folder keeps its progress, another one is a new machine key and starts over. */
function enableClaude(prev, dir) {
    const same = prev?.dir === dir;
    return {
        on: true,
        dir,
        historySent: same ? prev.historySent : false,
        ...(same && prev.syncedThrough ? { syncedThrough: prev.syncedThrough } : {}),
        ...(prev?.fallbackId ? { fallbackId: prev.fallbackId } : {}),
    };
}
function explainClaude(dir) {
    log(`\n  Claude Code usage reads the logs in ${join(dir, "projects")}: per reply only its model, its four token counts,`);
    log(`  its day, its session id and the Claude Code version. Never your messages, Claude's answers, paths or project names.`);
    log(`  What gets sent per UTC day per model: input, output, cache-read and cache-write tokens, replies and sessions,`);
    log(`  plus a keyed hash of this computer. Message and session ids stay here. See the numbers first: gitstats claude`);
}
const fmt = (n) => n.toLocaleString("en-US");
/** The last 14 days from this machine's logs, counted the way a sync counts them. No network, nothing written. */
async function claudeStatus() {
    const c = loadConfig();
    const dir = c?.claude?.dir ?? defaultClaudeDir();
    const to = utcToday();
    const from = addDays(to, -13);
    const started = Date.now();
    const n = await countClaude(dir, from, to, Date.parse(`${from}T00:00:00Z`));
    log(`  Claude Code usage from ${join(dir, "projects")}, last 14 days (UTC) · nothing is sent\n`);
    log(`  ${"date".padEnd(10)} ${"replies".padStart(8)} ${"sessions".padStart(8)} ${"tokens".padStart(16)} ${"output".padStart(12)}  top model`);
    const total = { replies: 0, sessions: 0, tokens: 0, output: 0 };
    for (let day = from; day <= to; day = addDays(day, 1)) {
        const rows = n.days.filter((d) => d.date === day);
        const tokens = (d) => d.input + d.output + d.cacheRead + d.cacheWrite;
        const sum = { replies: 0, sessions: 0, tokens: 0, output: 0 };
        for (const d of rows) {
            sum.replies += d.replies;
            sum.sessions += d.sessions;
            sum.tokens += tokens(d);
            sum.output += d.output;
        }
        const top = [...rows].sort((x, y) => tokens(y) - tokens(x))[0]?.model ?? "-";
        for (const k of ["replies", "sessions", "tokens", "output"])
            total[k] += sum[k];
        log(`  ${day} ${fmt(sum.replies).padStart(8)} ${fmt(sum.sessions).padStart(8)} ${fmt(sum.tokens).padStart(16)} ${fmt(sum.output).padStart(12)}  ${top}`);
    }
    log(`  ${"total".padEnd(10)} ${fmt(total.replies).padStart(8)} ${fmt(total.sessions).padStart(8)} ${fmt(total.tokens).padStart(16)} ${fmt(total.output).padStart(12)}`);
    log(`\n  ${n.files} files read in ${((Date.now() - started) / 1000).toFixed(1)}s${n.files > 0 && n.recognised === 0 ? " · no usage recognised: the log format may have changed" : ""}`);
    if (!c)
        log("  this computer is not linked yet: npx @yaroslavhaidash/gitstats-cli@latest link --claude");
    else if (!c.claude?.on)
        log("  counting: off · `gitstats claude on` sends these numbers with every sync");
    else
        log(`  counting: on · synced through ${c.claude.syncedThrough ?? "never"}${c.claude.lastError ? ` · last error: ${c.claude.lastError}` : ""}`);
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
        log(`  ${r.label.padEnd(40)} ${String(cm).padStart(5)} commits  +${a} −${d}${pending > 0 ? `  (${pending} pending)` : ""}${r.since ? "  (full history)" : ""}`);
    }
}
async function confirm(question, yesByDefault = true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${question} ${yesByDefault ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    rl.close();
    return answer === "" ? yesByDefault : answer === "y" || answer === "yes";
}
/**
 * `history` counts every repo whose full history this machine has not uploaded yet from
 * HISTORY_FROM, once; the rest get the last year, as always. `progress` names each of those repos as
 * it goes, for `link`, where the first count can take minutes.
 */
function count(c, since, fetch = !args.includes("--no-fetch"), history = false, progress = false) {
    const repos = findRepos(c.roots, c.repos);
    // Worktrees and extra clones share a remote: fetch and count the primary clone only (they read the same origin/HEAD).
    const primary = [];
    const seen = new Set();
    for (const r of repos) {
        const info = remoteInfo(r);
        if (seen.has(info.key))
            continue;
        seen.add(info.key);
        primary.push({ path: r, ...info });
    }
    const sent = new Set(c.historySent ?? []);
    const full = history ? primary.filter((r) => !sent.has(remoteHash(c.salt, r.key))).length : 0;
    if (full > 0 && progress)
        log(`  counting full history for ${full} repos (once)`);
    const reports = [];
    /** Counted in full and none of it yours: done too, or it would be counted in full on every sync. */
    const nothingOld = [];
    let done = 0;
    for (const r of primary) {
        const historyFrom = history && !sent.has(remoteHash(c.salt, r.key)) ? HISTORY_FROM : null;
        if (historyFrom && progress)
            log(`  [${++done}/${full}] ${r.label}`);
        const rep = countRepo(r.path, c.emails, since, c.salt, c.sendNames, fetch, historyFrom);
        if (rep)
            reports.push(rep);
        else if (historyFrom)
            nothingOld.push(remoteHash(c.salt, r.key));
    }
    return { scanned: repos.length, reports, nothingOld };
}
/** Full-history repos in request-sized groups, packed in order. One repo alone always fits the server's per-repo cap. */
function packHistory(reports) {
    const groups = [];
    let group = [];
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
    if (group.length > 0)
        groups.push(group);
    return groups;
}
async function send(c, reports, claude = null) {
    const payload = reports.map(({ remoteHash, name, language, weeks, days, pending, since }) => ({ remoteHash, name, language, weeks, days, pending, ...(since ? { since } : {}) }));
    return post(c.server, "/api/ingest", { cliVersion: runningVersion(), repos: payload, ...(claude ? { claude } : {}) }, c.token);
}
/**
 * The first request carries the last-year repos, exactly as before 0.4.0. Full histories follow in
 * further requests, and a repo joins `historySent` only once its request returned 200, so a failed
 * one is counted and sent again next time. Re-sending a history replaces the same rows.
 * Claude Code usage rides the first request; its window counts as sent only once the server says so.
 */
async function upload(c, reports, nothingOld = [], claude = null) {
    const { status, body } = await send(c, reports.filter((r) => !r.since), claude);
    if (status !== 200 || !body) {
        c.lastSync = { at: new Date().toISOString(), repos: 0, weeks: 0, error: `server answered ${status}` };
        saveConfig(c);
        throw new Error(status === 401 ? "this computer is no longer linked; run `gitstats link` again" : `sync failed: HTTP ${status}`);
    }
    if (body.outdated)
        log(`this computer runs ${runningVersion()}; the board expects ${body.minVersion} or newer — run \`gitstats update\``);
    let claudeDays = null;
    if (claude && c.claude) {
        if (isRecord(body.claude) && typeof body.claude.days === "number") {
            claudeDays = body.claude.days;
            c.claude.syncedThrough = claude.to;
            c.claude.historySent = true;
            delete c.claude.lastError;
        }
        else {
            c.claude.lastError = body.claude === "rejected" ? "claude: the server rejected the upload" : "claude: the server did not take the upload";
            logFile(c.claude.lastError);
        }
    }
    const total = { repos: body.repos, weeks: body.weeks, requests: 1, history: 0, historyLeft: 0, claudeDays };
    const groups = packHistory(reports.filter((r) => r.since));
    let error;
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
    if (!error)
        c.historySent = [...new Set([...(c.historySent ?? []), ...nothingOld])];
    c.lastSync = { at: new Date().toISOString(), repos: total.repos, weeks: total.weeks, ...(error ? { error } : {}) };
    saveConfig(c);
    if (groups.length > 0) {
        logFile(`full history: ${total.history} repos sent from ${HISTORY_FROM} in ${total.requests - 1} request${total.requests === 2 ? "" : "s"}${error ? `, ${total.historyLeft} left for the next sync (${error})` : ""}`);
    }
    return total;
}
async function sync(c, quiet = false) {
    const restarted = await selfUpdate(c);
    if (restarted !== null)
        process.exit(restarted);
    if (args.includes("--history")) {
        c.historySent = [];
        if (c.claude)
            c.claude.historySent = false;
        saveConfig(c);
    }
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
    const { scanned, reports, nothingOld } = count(c, since, !args.includes("--no-fetch"), true, !quiet);
    const claude = await claudeUpload(c);
    const body = await upload(c, reports, nothingOld, claude);
    if (!quiet) {
        const full = reports.filter((r) => r.since).length;
        log(`scanned ${scanned} repos, ${reports.length} with your commits${full > 0 ? ` (${full} counted in full, once)` : " in the last year"}, ${body.weeks} weekly rows sent in ${body.requests} request${body.requests === 1 ? "" : "s"}`);
        if (body.historyLeft > 0)
            log(`${body.historyLeft} full histories were not accepted (${c.lastSync?.error}); the next sync sends them again`);
        summarize(reports);
        if (c.claude?.on)
            log(body.claudeDays !== null ? `Claude Code usage: ${body.claudeDays} day×model rows sent for ${claude?.from} to ${claude?.to}` : `Claude Code usage: not sent (${c.claude.lastError ?? "nothing counted"})`);
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
function installSelf() {
    const here = dirname(fileURLToPath(import.meta.url)); // .../dist
    const pkgRoot = resolve(here, "..");
    if (pkgRoot === resolve(SELF))
        return writeShim();
    const tmp = mkdtempSync(join(tmpdir(), "gitstats-install-"));
    try {
        cpSync(join(pkgRoot, "dist"), join(tmp, "dist"), { recursive: true });
        cpSync(join(pkgRoot, "package.json"), join(tmp, "package.json"));
        rmSync(SELF, { recursive: true, force: true });
        mkdirSync(SELF, { recursive: true });
        cpSync(join(tmp, "dist"), join(SELF, "dist"), { recursive: true });
        cpSync(join(tmp, "package.json"), join(SELF, "package.json"));
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    return writeShim();
}
/** A `gitstats` command for shells that have ~/.gitstats/bin on PATH; the npx form works regardless. */
function writeShim() {
    const script = join(SELF, "dist", "cli.js");
    mkdirSync(BIN, { recursive: true });
    if (platform() === "win32") {
        writeFileSync(join(BIN, "gitstats.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    }
    else {
        writeFileSync(join(BIN, "gitstats"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    return script;
}
function readVersion(pkgRoot) {
    try {
        const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
        const v = typeof pkg === "object" && pkg !== null ? pkg.version : null;
        return typeof v === "string" ? v : "unknown";
    }
    catch {
        return "unknown";
    }
}
function installedVersion() {
    return readVersion(SELF);
}
/** The copy that is executing right now — an npx run is not the installed one. */
function runningVersion() {
    return readVersion(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
/** Numeric semver compare; a pre-release suffix is ignored, this package never ships one. */
function isNewer(candidate, current) {
    const parts = (v) => v.split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
    const a = parts(candidate);
    const b = parts(current);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
}
/** The registry's record for the latest published version. */
async function latestMeta() {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(5000) });
    if (!res.ok)
        throw new Error(`registry answered ${res.status}`);
    const meta = await res.json();
    if (typeof meta !== "object" || meta === null)
        throw new Error("registry sent no metadata");
    return meta;
}
/**
 * Replace ~/.gitstats/cli with the latest published package. The schedule points at an absolute
 * path inside it and the config lives beside it, so neither is touched.
 * No npm: the scheduler starts the job with a minimal PATH that has node (by absolute path) but
 * not npm, so the tarball is fetched directly and checked against the registry's sha512 integrity.
 */
async function update(meta) {
    const before = installedVersion();
    const dist = typeof meta.dist === "object" && meta.dist !== null ? meta.dist : {};
    const { tarball, integrity } = dist;
    if (typeof tarball !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
        throw new Error("registry sent no tarball or sha512 integrity");
    }
    const res = await fetch(tarball, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok)
        throw new Error(`could not download ${PKG}@${String(meta.version)} — registry answered ${res.status}`);
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
        if (untar.status !== 0)
            throw new Error("could not unpack the download (is tar available?)");
        const root = join(tmp, "package");
        if (!existsSync(join(root, "dist", "cli.js")))
            throw new Error("the published package has no dist/cli.js");
        rmSync(join(SELF, "dist"), { recursive: true, force: true });
        mkdirSync(SELF, { recursive: true });
        cpSync(join(root, "dist"), join(SELF, "dist"), { recursive: true });
        cpSync(join(root, "package.json"), join(SELF, "package.json"));
        writeShim();
        log(`updated ${before} → ${installedVersion()} · config and schedule untouched`);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}
/**
 * Asks the registry for a newer version at most once a day, installs it and restarts the sync under
 * it. Nothing here may fail a sync: offline, a registry error or a bad download is one log line and
 * the current version carries on. `--no-update` skips the check entirely.
 * Returns the exit code of the restarted sync, or null when this process should carry on itself.
 */
async function selfUpdate(c) {
    if (args.includes("--no-update"))
        return null;
    const last = c.lastUpdateCheck ? Date.parse(c.lastUpdateCheck) : 0;
    if (Number.isFinite(last) && Date.now() - last < UPDATE_EVERY_MS)
        return null;
    // Stamped before the fetch, so a registry that is down is retried tomorrow and not every sync.
    c.lastUpdateCheck = new Date().toISOString();
    saveConfig(c);
    const current = runningVersion();
    try {
        const meta = await latestMeta();
        if (typeof meta.version !== "string")
            throw new Error("registry sent no version");
        if (!isNewer(meta.version, current))
            return null;
        await update(meta);
        const fresh = spawnSync(process.execPath, [join(SELF, "dist", "cli.js"), "sync", "--quiet"], { stdio: "inherit" });
        return fresh.status ?? 1;
    }
    catch (e) {
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
function scheduleInstalled() {
    const os = platform();
    if (os === "darwin")
        return existsSync(PLIST) || existsSync(LEGACY_PLIST);
    if (os === "win32")
        return [JOB, "gitstats-sync"].some((t) => spawnSync("schtasks", ["/Query", "/TN", t], { stdio: "ignore" }).status === 0);
    return existsSync(TIMER) || existsSync(LEGACY_TIMER);
}
/**
 * Drop a pre-0.3.5 entry so it cannot run alongside the hashed one. On macOS and Linux the entry is
 * a file under this HOME, so a run under another HOME finds nothing and leaves the real machine's
 * job alone; on Windows the task belongs to the signed-in account either way.
 */
function removeLegacySchedule() {
    const os = platform();
    if (os === "darwin") {
        if (!existsSync(LEGACY_PLIST))
            return;
        spawnSync("launchctl", ["unload", LEGACY_PLIST], { stdio: "ignore" });
        rmSync(LEGACY_PLIST, { force: true });
    }
    else if (os === "win32") {
        spawnSync("schtasks", ["/Delete", "/TN", "gitstats-sync", "/F"], { stdio: "ignore" });
    }
    else {
        if (!existsSync(LEGACY_TIMER))
            return;
        spawnSync("systemctl", ["--user", "disable", "--now", "gitstats-sync.timer"], { stdio: "ignore" });
        rmSync(LEGACY_TIMER, { force: true });
        rmSync(join(UNIT_DIR, "gitstats-sync.service"), { force: true });
    }
}
function installSchedule() {
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
function removeSchedule() {
    const os = platform();
    if (os === "darwin") {
        spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
        rmSync(PLIST, { force: true });
    }
    else if (os === "win32") {
        spawnSync("schtasks", ["/Delete", "/TN", JOB, "/F"], { stdio: "ignore" });
    }
    else {
        spawnSync("systemctl", ["--user", "disable", "--now", `${JOB}.timer`], { stdio: "ignore" });
        rmSync(TIMER, { force: true });
        rmSync(join(UNIT_DIR, `${JOB}.service`), { force: true });
    }
    // A machine that paused or unlinked before upgrading still has the old entry; leaving it behind
    // would keep syncing after the user asked it to stop.
    removeLegacySchedule();
}
function openBrowser(url) {
    const os = platform();
    const [bin, a] = os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    spawnSync(bin, a, { stdio: "ignore" });
}
// ---------- commands ----------
async function revokeOnServer(server, token) {
    const res = await fetch(`${server}/api/cli/unlink`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    return res?.ok ?? false;
}
async function link() {
    const server = (args.includes("--server") ? args[args.indexOf("--server") + 1] : undefined) ?? DEFAULT_SERVER;
    const expect = args.includes("--user") ? args[args.indexOf("--user") + 1] : undefined;
    log(`\n  Pairing with ${server}. The browser will ask you to confirm as the GitHub account you are signed in with there.`);
    if (expect)
        log(`  Expecting ${expect}; anything else is refused.`);
    const previous = loadConfig();
    if (previous) {
        log(`  this computer is already linked as ${previous.login}; replacing the link${(await revokeOnServer(previous.server, previous.token)) ? " (old one revoked)" : ""}`);
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
    log(`\n  linked as ${done.login}`);
    // The browser may have been signed in as somebody else entirely; `--user` is the only way to say
    // up front whose board this machine belongs on, so a mismatch revokes rather than reports.
    if (expect && expect.toLowerCase() !== done.login.toLowerCase()) {
        const revoked = await revokeOnServer(server, done.token);
        throw new Error(`confirmed as ${done.login}, not ${expect} — nothing was linked${revoked ? " and the pairing was revoked" : "; revoke this computer on the settings page"}. Sign in as ${expect} in the browser, then run link again.`);
    }
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
    log(`  counting commits by: ${[...emails].join(", ") || "(no email found; run: gitstats emails add you@example.com)"}`);
    log(`  scanning ${c.roots.join(", ")} for git repos… (this first run can take a minute)\n`);
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
    const { scanned, reports, nothingOld } = count(c, since, !args.includes("--no-fetch"), true, true);
    log(`  found ${scanned} repos, ${reports.length} with your commits (each one's full history this first time):`);
    summarize(reports);
    log(`\n  What gets sent per repo: a keyed hash of its remote URL, the language guess, the weekly numbers above, and commits-per-day counts.`);
    log(`  Repo names are NOT sent (turn on later with: gitstats names on).`);
    if (!args.includes("--yes") && !(await confirm("  Upload these numbers to your gitstats profile?"))) {
        rmSync(DIR, { recursive: true, force: true });
        log("  cancelled; nothing was uploaded and the link was removed locally (revoke it on the settings page).");
        return;
    }
    // Off unless asked: `--yes` alone never turns it on, so a scripted link sends what it always did.
    const claudeDir = defaultClaudeDir();
    if (existsSync(join(claudeDir, "projects"))) {
        if (args.includes("--claude") || !args.includes("--yes"))
            explainClaude(claudeDir);
        if (args.includes("--claude") || (!args.includes("--yes") && (await confirm("\n  Also count your Claude Code usage (tokens per day per model, numbers only)?", false)))) {
            // A relink keeps the machine key's fallback id, so the history it re-sends replaces the same rows.
            c.claude = { ...enableClaude(undefined, claudeDir), ...(previous?.claude?.fallbackId ? { fallbackId: previous.claude.fallbackId } : {}) };
            saveConfig(c);
            log("  counting Claude Code usage (every log Claude Code still keeps, this first time)…");
        }
    }
    const claude = await claudeUpload(c);
    const body = await upload(c, reports, nothingOld, claude);
    log(`  uploaded ${body.weeks} weekly rows for ${body.repos} repos in ${body.requests} request${body.requests === 1 ? "" : "s"}${body.historyLeft > 0 ? `; ${body.historyLeft} full histories were not accepted and go with the next sync` : ""}`);
    if (c.claude?.on)
        log(body.claudeDays !== null ? `  Claude Code usage: ${body.claudeDays} day×model rows sent` : `  Claude Code usage: not sent (${c.claude.lastError ?? "nothing counted"}); the next sync tries again`);
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
function stats() {
    const roots = args.flatMap((a, i) => (a === "--root" && args[i + 1] ? [resolve(args[i + 1])] : []));
    const given = args.flatMap((a, i) => (a === "--email" && args[i + 1] ? [args[i + 1]] : []));
    // `link` also counts the GitHub noreply address, but that needs the account id a pairing returns.
    const global = globalEmail();
    const emails = given.length > 0 ? given : global ? [global] : [];
    // Never written anywhere: the salt only exists because `countRepo` hashes a remote it will not send.
    const c = {
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
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    log(`\n  last ${DAYS} days: ${plural(commits, "commit")}, +${additions} −${deletions} lines, ${plural(reports.length, "repo")}, ${plural(days, "active day")}`);
    log(`  nothing was sent · after \`link\` these numbers go to your page on ${DEFAULT_SERVER.replace("https://", "")}`);
}
function requireConfig() {
    const c = loadConfig();
    if (!c)
        throw new Error("not linked yet; run: npx @yaroslavhaidash/gitstats-cli@latest link");
    return c;
}
async function main() {
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
            log(`claude    ${c.claude?.on ? `on · synced through ${c.claude.syncedThrough ?? "never"}${c.claude.lastError ? ` · ERROR ${c.claude.lastError}` : ""}` : "off"}`);
            return;
        }
        case "claude": {
            if (args[1] === "on") {
                const c = requireConfig();
                const dir = defaultClaudeDir();
                if (!existsSync(join(dir, "projects")))
                    throw new Error(`no Claude Code logs in ${join(dir, "projects")}; set CLAUDE_CONFIG_DIR if they live elsewhere`);
                explainClaude(dir);
                if (!args.includes("--yes") && !(await confirm("\n  Send these numbers to your gitstats profile with every sync?", false))) {
                    log("  nothing changed");
                    return;
                }
                c.claude = enableClaude(c.claude, dir);
                saveConfig(c);
                log(`  Claude Code usage: on${c.claude.historySent ? "" : " · this first sync counts every log Claude Code still keeps"}`);
                return sync(c);
            }
            if (args[1] === "off") {
                const c = requireConfig();
                if (c.claude)
                    c.claude.on = false;
                saveConfig(c);
                log(`Claude Code usage: not sent any more. What was already sent stays on your page until you delete it on the settings page: ${c.server}/dashboard/settings`);
                return;
            }
            return claudeStatus();
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
        case "update":
            requireConfig();
            return update(await latestMeta());
        case "unlink": {
            const c = loadConfig();
            removeSchedule();
            if (c)
                log((await revokeOnServer(c.server, c.token)) ? "revoked on the server" : "could not reach the server; revoke this computer on the settings page");
            rmSync(DIR, { recursive: true, force: true });
            log("unlinked");
            return;
        }
        default:
            log("usage: gitstats <link [--user <login>] [--root <dir>]... [--yes] [--claude] | stats [--root <dir>]... [--fetch] | sync [--history] [--no-fetch] [--no-update] | status | add <path> | roots add <dir> | emails add <email> | names on|off | claude [on [--yes] | off] | pause | resume | update | unlink>");
    }
}
main().catch((e) => {
    console.error(`gitstats: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
