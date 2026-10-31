# gitstats-cli

Counts commits and lines in the git repos on your computer and sends **only the numbers** (per repo, per week) to your [gitstats](https://gitstats.org) profile. No file contents, no diffs, no GitHub tokens, no permissions on GitHub.

Not ready to sign up for anything? Start here — it pairs with nothing, uploads nothing, writes no
config and makes no network call at all. It reads your git history, prints the table, and exits:

```bash
npx @yaroslavhaidash/gitstats-cli@latest stats
```

Run it before `link`, with no account. `--root <dir>` and `--email <addr>` (both repeatable) pick where to look and whose commits count; `--fetch` refreshes each repo from its remote first.

When you want the numbers on a board:

```bash
npx @yaroslavhaidash/gitstats-cli@latest link
```

That pairs this computer (you confirm in the browser), scans your home folder for repos, uploads each repo's full history once (every later sync recounts the last year), and installs a daily background sync (launchd on macOS, Task Scheduler on Windows, systemd user timer on Linux). Nothing else to remember.

`link` shows you exactly what it found and asks before the first upload. It confirms in whichever browser your OS calls default, so it names the account it paired as on its own line before it scans anything — and `link --user <login>` refuses the pairing outright if the browser confirmed as somebody else.

The background job is named after your config directory (`com.gitstats.sync.<hash>` on macOS, `gitstats-sync-<hash>` elsewhere), so a second install under another `HOME` cannot replace or remove the one your real machine registered. Upgrading from 0.3.4 or earlier: the first `link` or `resume` swaps the old shared entry for the named one.

What leaves the machine, per repo: an HMAC-SHA256 of the normalised remote URL keyed with a per-user secret the server issued at pairing (so the same repo from two of your machines counts once, and public repos the server already knows are recognised without sending their name), a guessed main language, `{week, additions, deletions, commits}` and `{date, additions, deletions, commits}` for your commits (`git log --no-merges --fixed-strings --author=<your emails>` on the default branch, exact email match, weeks bucketed Sunday 00:00 UTC), and the same two shapes again under `pending` for work sitting on branches the default branch has not taken in yet. Repo names are **not** sent unless you run `gitstats names on`. Honest limit: the HMAC key lives on the server, so the server could confirm a guess about a specific URL; it cannot enumerate your repos from the hashes.

**Claude Code usage (on by default since 0.6.0).** A linked computer also counts your Claude Code tokens from its own logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`). From each reply it reads only the model, the four token counts, the time, the effort level, the type and id of each content block (to count tool calls), whether a subagent ran it, the session id and the Claude Code version; from each prompt you typed only that it is one and when. Never your messages, Claude's answers, tool names, paths or project names. It sends per UTC day per model: input, output, cache-read and cache-write tokens, replies and sessions, and since 0.7.0 replies and output per effort level, tool calls, subagent tokens and replies, replies in each 6-hour block of your local day and how many messages you typed; the highest Claude Code version seen, and an HMAC of this computer's platform id keyed with your secret, so each computer replaces only its own rows. Replies that Claude Code writes several times or copies into resumed sessions are deduped by message id on your machine; message and session ids and timestamps never leave it. Each sync recounts the last week; the first one, and the first after updating to 0.7.0, counts every log Claude Code still keeps. `gitstats claude` prints the last 14 days without sending anything. To stop: turn it off on the settings page (every computer stops reading the logs after its next sync), or `gitstats claude off` on one computer (`link --no-claude` while pairing); `gitstats claude on` turns that computer back on.

This CLI is open source: `npx` runs the `dist/` committed in this repo, built from `src/cli.ts`, one file with no dependencies. Read it, or watch its traffic with a proxy.

Commands: `stats` (local only, sends nothing) · `sync` (`--history` recounts every repo in full) · `status` · `add <path>` · `roots add <dir>` · `emails add <email>` · `names on|off` · `claude [on|off]` · `update` · `unlink` (also revokes server-side). It keeps itself up to date: every sync checks npm at most once a day and installs a newer version before finishing, `sync --no-update` skips that. Config lives in `~/.gitstats/config.json` (mode 600).
