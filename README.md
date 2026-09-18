# gitstats-cli

Counts commits and lines in the git repos on your computer and sends **only the numbers** (per repo, per week) to your [gitstats](https://gitstats-three-zeta.vercel.app) profile. No file contents, no diffs, no GitHub tokens, no permissions on GitHub.

```bash
npx --yes github:yaroslavhaidash/gitstats-cli link
```

That pairs this computer (you confirm in the browser), scans your home folder for repos, uploads the last year, and installs a daily background sync (launchd on macOS, Task Scheduler on Windows, systemd user timer on Linux). Nothing else to remember.

What leaves the machine, per repo: a sha256 of the remote URL, the `owner/name` for GitHub remotes (so public repos aren't double counted), a guessed main language, and `{week, additions, deletions, commits}` for your commits (`git log --no-merges --author=<your emails>` on the default branch, weeks bucketed Sunday 00:00 UTC). Read `src/cli.ts`, it is ~350 lines.

Commands: `sync` · `status` · `add <path>` · `emails add <email>` · `unlink`. Config lives in `~/.gitstats/config.json`.
