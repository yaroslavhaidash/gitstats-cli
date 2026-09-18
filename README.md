# gitstats-cli

Counts commits and lines in the git repos on your computer and sends **only the numbers** (per repo, per week) to your [gitstats](https://gitstats-three-zeta.vercel.app) profile. No file contents, no diffs, no GitHub tokens, no permissions on GitHub.

```bash
npx @yaroslavhaidash/gitstats-cli@latest link
```

That pairs this computer (you confirm in the browser), scans your home folder for repos, uploads the last year, and installs a daily background sync (launchd on macOS, Task Scheduler on Windows, systemd user timer on Linux). Nothing else to remember.

`link` shows you exactly what it found and asks before the first upload.

What leaves the machine, per repo: an HMAC-SHA256 of the normalised remote URL keyed with a per-user secret the server issued at pairing (so the same repo from two of your machines counts once, and public repos the server already knows are recognised without sending their name), a guessed main language, `{week, additions, deletions, commits}` and `{day, commits}` for your commits (`git log --no-merges --fixed-strings --author=<your emails>` on the default branch, exact email match, weeks bucketed Sunday 00:00 UTC). Repo names are **not** sent unless you run `gitstats names on`. Honest limit: the HMAC key lives on the server, so the operator could confirm a guess about a specific URL; he cannot enumerate your repos from the hashes.

You are trusting the operator: `npx github:…` runs the committed `dist/` from this repo. Read `src/cli.ts` (~400 lines) or watch the payload with a proxy.

Commands: `sync` · `status` · `add <path>` · `roots add <dir>` · `emails add <email>` · `names on|off` · `unlink` (also revokes server-side). Config lives in `~/.gitstats/config.json` (mode 600).
