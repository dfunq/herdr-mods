# herdr-mods — notes for agents working on this repo

The README covers what's here and how users install it. This file is the handoff for changing and releasing it.

**This repo is public.** Nothing committed may name a real person, company, machine, home folder, Jira site, project or ticket key, peerlink agent or space, including in commit messages and release notes. Nothing org-specific may be hardcoded: the Jira site (optional `site` in `~/.herdr-jira/app.json`), project keys (the panel's link keys, shared state `link.keys`, which also scope the Sprint tab) and the default agent (shared `jira.send.agent`, else the first live agent) all come from the user's own settings. Before every push: `git grep -niE '<the names you know from this machine>'` and `git log -1 --format=%an`.

## What's in it

- `mods/work/`: the **work** herdr-app mod (Jira panel, GitHub tab, Send to agent, a button that opens peerlink's web UI). It was called `jira` before 0.1.0. Kept on purpose so existing installs carry over: the `~/.herdr-jira/` data folder (login tokens, `app.json`, logs), the `enabled("jira")` integration toggle, and the `jira.*` shared-state keys. The mod's own ids (`openOverlay({mod: "work"})`, `mods/work/...` asset paths) must match the folder name. Its layout block is `work-panel`, not `work`: `work` is herdr's middle column, and reusing it broke drag-resize (SKY-718), so `layout.resize` targets `work-panel`.
- `layouts/herdr-work.json`: the layout, with peerlink's `peerlink-spaces` and `peerlink-agents` panels and the `work` block.
- `_home/.herdr-jira/`: `oauth.py` (Atlassian sign-in) and `stt.py` (dictation), copied to the user's home.
- `plugins/agent-model/`: a plugin for the **herdr terminal app** (not herdr-app) that shows `$model`/`$effort` sidebar tokens. Opt-in.

## How it gets installed

- **Mods, layouts, `_home`:** peerlink's web UI, Settings → herdr app → **Install herdr mods**, copying from the clone named in `herdr_mods_source`. Only the owner's browser can press it; agents can't. It copies `mods/<name>/`, adds a layout only if that file doesn't exist yet (herdr-app saves the user's arrangement into it), copies `_home/.herdr-*`, backs up what it replaces to `~/.peerlink/backups/`, and **never deletes**: a renamed mod or layout leaves the old one behind (see the README's upgrade section). It never copies `plugins/`, `tokens.json`, `app.json`, logs or `jsconfig.json`.
- **plugins/agent-model:** `herdr plugin install dfunq/herdr-mods/plugins/agent-model --ref vX.Y.Z`. A local folder is added with `herdr plugin link` and removed with `unlink` (not `uninstall`). herdr runs a plugin's `[[startup]]` command only when the herdr server starts, so after installing, either restart herdr or start `model.py --watch` yourself with herdr's plugin env (`HERDR_PLUGIN_ID`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_ROOT`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`); otherwise the next herdr start runs a second watcher. Test an unreleased branch with `--ref <branch>`, and invoke its action with `herdr plugin action invoke refresh --plugin herdr-mods.agent-model`.

## Shipping a change

1. Branch off `main`, commit, push, open a PR. `main` has a ruleset: no force push, no deletion. Every PR gets an independent review before merge.
2. Bump `VERSION` in the PR (and `version` in a plugin's `herdr-plugin.toml` when the plugin changed).
3. Merge, then tag and release the merge commit:
   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title X.Y.Z --notes "<what changed for users>"
   ```
4. There's no CI. Check the JS with `node --input-type=module --check < mods/work/main.js` (and `github.js`), and Python with `python3 -m py_compile`.
5. Live-checking a mod change needs Install herdr mods pressed by the owner, or a copy into `~/.config/herdr-app/mods/work/` for a quick look. A later install overwrites that copy.
