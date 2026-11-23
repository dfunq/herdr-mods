# herdr mods

Mods for the [herdr](https://herdr.dev) app, made to pair with [peerlink](https://github.com/dfunq/peerlink), which lets the Claude Code agents in your herdr panes talk to each other. The **work** mod is a side panel for your work: Jira issues and sprints, GitHub PRs and issues, a **Send to agent** button that hands a ticket to a running peerlink agent, and a button that opens peerlink's web UI. Its layout, `herdr-work`, puts it beside peerlink's Spaces and Agents panels.

peerlink installs them: in its web UI, open Settings → **herdr app**, set the herdr mods folder to your clone of this repo (`herdr_mods_source`), and press **Install herdr mods**.

- `mods/<name>/`: copied to `~/.config/herdr-app/mods/<name>/`.
- `layouts/*.json`: added to `~/.config/herdr-app/layouts/`, only when that layout isn't there yet. herdr-app saves your own arrangement into it, so it's never replaced.
- Files it replaces are copied to `~/.peerlink/backups/herdr-mods-<time>/` first. They don't go beside the mod, because herdr-app would load a backup folder in `mods/` as another mod.
- `_home/`: copied into your home folder. Here that's `~/.herdr-jira/oauth.py` and `stt.py`, which the work mod runs (Jira sign-in and dictation).

## On a new machine
1. Clone the repo, set `herdr_mods_source` to the clone, and press **Install herdr mods**. To update later, `git pull` and press it again.
2. Jira sign-in: put the Atlassian app's id and secret in `~/.herdr-jira/app.json`, as
   `{ "client_id": "...", "client_secret": "..." }`. Make the file yourself; never paste it in chat. Then sign in from the work panel.
   If your login reaches more than one Jira site, add `"site": "your-site.atlassian.net"` to pick one; otherwise the first is used.
   In the panel's Settings, list your project keys (e.g. `ABC`): they scope the Sprint tab and PR-to-ticket linking. Empty means every project.
3. GitHub: the panel uses your own `gh` login (`gh auth login`).

`tokens.json`, `app.json` and logs are never committed (see `.gitignore`).
