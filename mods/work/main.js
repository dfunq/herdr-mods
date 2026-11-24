// Read-only Jira panel: your open issues or the open sprint, plus quick lookup by key or text.
// Auth: Atlassian OAuth through ~/.herdr-jira/oauth.py (app.json = your OAuth app, tokens.json = the login).
import { View, div, image, svg } from "gpui-kit";
import { installGithub, GH_ICON, enabled, linkCfg, ticketKeys, prsForKey, prColor } from "./github.js";
import { v_flex, h_flex, InputState, Input, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, home, readTextFile, theme, run, checking, nextCommand, props, openOverlay, closeOverlay, terminals, hc, notify, shared, setShared, window } from "herdr";

const STRIP = 48;
const DIR = () => `${home()}/.herdr-jira`;
const FIELDS = "summary,status,assignee,priority,issuetype,created,updated,parent,customfield_10020";
// Priority across schemes: P1/Highest first, P4/Lowest last; ties by created, newest first.
const PRI = { highest: 1, high: 2, medium: 3, low: 4, lowest: 5 };
const priRank = i => { const n = (i.fields?.priority?.name || "").toLowerCase(), m = n.match(/^p(\d)/); return m ? Number(m[1]) : PRI[n] ?? 9; };
const byPriority = (a, b) => priRank(a) - priRank(b) || Date.parse(b.fields?.created || 0) - Date.parse(a.fields?.created || 0);
// Text, typed JQL and saved filters all run inside the current tab's scope; a bare key is looked up directly.
const isJql = q => /[=~]|\border by\b|\b(in|is|was)\b.*\(/i.test(q);
// The Sprint tab covers the projects set in Settings (the PR-linking keys); none set means every open sprint.
const sprintJql = () => { const k = linkCfg().keys; return (k.length ? `project in (${k.join(", ")}) AND ` : "") + "sprint in openSprints()"; };
const searchScope = view => ({ mine: "assignee = currentUser()", sprint: sprintJql(), all: "" })[view];
const viewJql = view => ({
  mine: "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created DESC",
  sprint: `${sprintJql()} ORDER BY priority DESC, created DESC`,
  all: "statusCategory != Done ORDER BY priority DESC, created DESC",
})[view];
const GROUPINGS = { status: "status", assignee: "assignee", epic: "epic" };
const EPIC = "#9F8FEF";
const CONSOLE_URL = "https://developer.atlassian.com/console/myapps/";
// peerlink's web UI, with its own sign-in: peerlink asks on screen, then the browser opens signed in.
// ~/.peerlink/launch.json (written by peerlink) names its Python and daemon; else the launcher.
async function openPeerlink() {
  let conf = null;
  try { conf = JSON.parse(await readTextFile(`${home()}/.peerlink/launch.json`)); } catch {}
  const r = await (conf ? exec(conf.python, [conf.daemon, "web"], { timeout: 120000 })
    : exec(`${home()}/.peerlink/bin/peerlink`, ["web"], { timeout: 120000 })).catch(e => ({ code: 1, stderr: String(e) }));
  if (r.code !== 0) notify({ title: "peerlink", body: (r.stderr || r.stdout || "").trim().split("\n").pop() || "Couldn't open peerlink", level: "warning" });
}
const openUrl = url => window().platform === "windows" ? exec("rundll32", ["url.dll,FileProtocolHandler", url]) : exec("open", [url]);
const PY = () => window().platform === "windows" ? "python" : "python3";

async function helper(cmd, timeout = 30000) {
  const r = await exec(PY(), [`${DIR()}/oauth.py`, cmd], { timeout });
  try { return JSON.parse(r.stdout.trim().split("\n").pop()); }
  catch { return { error: (r.stderr || r.stdout || "helper failed").trim().split("\n").pop() }; }
}

function typeIcon(type) {
  const n = (type?.name || "").toLowerCase();
  const k = /escalation|outage|incident|break/.test(n) ? "breakfix"
    : type?.subtask || n.includes("sub") ? "subtask" : n.includes("bug") ? "bug" : n.includes("story") ? "story"
    : n.includes("epic") ? "epic" : n.includes("task") ? "task" : "other";
  return `mods/work/icons/${k}.svg`;
}

// Column order: To Do, In Progress, Blocked, In Review, Ready for QA, then Done.
// Statuses not in this list slot in next to their nearest neighbour.
const ORDER = ["to do", "selected for development", "in progress", "blocked", "needs more information", "in review", "review",
  "ready for qa", "qa", "deferred", "backlog", "done"];
function rank(g) {
  const i = ORDER.indexOf(g.name.toLowerCase());
  if (i >= 0) return i;
  return g.cat === "new" ? 0.5 : g.cat === "indeterminate" ? 8.5 : g.cat === "done" ? 20 : 10;
}

const initials = n => (n || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const AVATAR = ["#5E6AD2", "#2684FF", "#00A3BF", "#36B37E", "#FF8B00", "#E5493A", "#904EE2", "#6554C0"];
const avatarColor = n => AVATAR[[...(n || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];
const avatar = (name, size) => div().w(size).h(size).flex_none().rounded(size / 2).bg(name ? avatarColor(name) : "#8993A4")
  .flex().items_center().justify_center().text_size(size * 0.4).font_semibold().text_color("#ffffff").child(name ? initials(name) : "?");

// P1 red, P2 orange; P3 yellow, P4 blue, P5 grey.
function prioColor(name) {
  const n = (name || "").toLowerCase();
  return /p1|highest|critical|blocker/.test(n) ? "#F87168" : /p2|high/.test(n) ? "#FF8B00"
    : /p3|medium/.test(n) ? "#F5CD47" : /p4|low(?!est)/.test(n) ? "#579DFF" : "#8993A4";
}
const prioPill = (name, size = 10.5) => {
  const c = prioColor(name);
  return div().px(5).rounded(4).bg(c + "26").border(1).border_color(c + "66").text_size(size).font_semibold().text_color(c).child(name);
};

// The issue's current sprint (active first, then the next future one); null when it's in no open sprint.
function sprintOf(f) {
  const open = (f.customfield_10020 || []).filter(x => x.state === "active" || x.state === "future");
  return open.find(x => x.state === "active") || open[0] || null;
}
const sprintChip = (sp, t) => {
  const short = (sp.name.match(/sprint\s*\d+/i) || [sp.name])[0];
  const active = sp.state === "active";
  return div().px(5).rounded(4).text_size(10.5).font_semibold()
    .bg(active ? "#579DFF26" : t.raised).text_color(active ? "#579DFF" : t.dim).child(active ? short : `Next: ${short}`);
};

// Send to agent: types the ticket (plus an optional prompt) into a live peerlink agent's terminal.
// The default agent is set with the "Make default" checkbox in the send dialog (shared state "jira.send"); until set, the first live agent.
const defaultAgent = () => (shared("jira.send") || {}).agent || "";
// peerlink labels each agent's terminal with the agent's id (a3); its name comes from ~/.peerlink/agents.json.
let agentNames = {};
const loadAgentNames = async cx => {
  try {
    const d = JSON.parse(await readTextFile(`${home()}/.peerlink/agents.json`) || "{}");
    agentNames = Object.fromEntries((d.agents || []).filter(a => a.id && a.name).map(a => [a.id, a.name]));
    cx?.notify();
  } catch {}
};
const liveAgents = () => terminals()
  .filter(k => k.state === "live" && k.labels?.["peerlink.agent"])
  .map(k => ({ name: agentNames[k.labels["peerlink.agent"]] || k.labels["peerlink.agent"], address: k.address, status: typeof k.status === "string" ? k.status : (k.status?.state || "") }))
  .sort((a, b) => a.name.localeCompare(b.name));
const sendLog = line => { try { const stamp = `${new Date().toISOString()} ${String(line)}`; if (window().platform === "windows") exec("powershell", ["-NoProfile", "-Command", `Add-Content -LiteralPath '${home()}\\.herdr-jira\\send.log' -Value '${stamp.replace(/'/g, "''")}'`]); else exec("/bin/sh", ["-c", 'printf "%s\\n" "$1" >> "$2"', "sh", stamp, `${DIR()}/send.log`]); } catch {} };
const ticketLine = (issue, site) => {
  const f = issue.fields || {};
  return `Jira ${issue.key} (${[f.issuetype?.name, f.status?.name, f.priority?.name].filter(Boolean).join(", ")}): ${f.summary || ""}${site ? ` - ${site}/browse/${issue.key}` : ""}`;
};

function ago(iso) {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export default class Jira extends View {
  init(_props, cx) {
    const p = props();
    // An issue dialog and a PR dialog both need it: a PR dialog's link bar opens linked issues in place (SKY-720).
    // State can't be made during render, so it's made here.
    if (p?.pr || p?.issue) this.commentBox = TextareaState.new({ placeholder: "Add a comment…", rows: 3 });
    if (p?.pr) {
      this.prRef = p.pr; this.overlay = p.overlay; this.linkInit("pr");
      if (!checking()) this.loadPR(cx);
      return;
    }
    if (p?.ghSettings) {
      this.ghSettingsMode = true; this.overlay = p.overlay;
      this.ghSettingsInit(cx);
      return;
    }
    if (p?.send) {
      this.sendIssue = p.send; this.overlay = p.overlay;
      if (!checking()) cx.spawn(async cx => loadAgentNames(cx));
      this.agent = defaultAgent() || liveAgents()[0]?.name || ""; this.agentMenu = false; this.makeDefault = false;
      this.prompt = TextareaState.new({ placeholder: "What should the agent do with it? (optional)", rows: 6 });
      // Enter sends (dropping the newline the textarea just typed); Shift+Enter keeps its newline.
      this.prompt.on("submit", (e, cx) => {
        console.log(`jira send: submit shift=${!!e?.shift} secondary=${!!e?.secondary}`);
        if (e?.shift) return;
        const v = this.prompt.value(), at = this.prompt.selected_range().start;
        if (v[at - 1] === "\n") this.prompt.set_value(v.slice(0, at - 1) + v.slice(at));
        this.doSend(cx);
      });
      if (!checking()) cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "do-send") this.doSend(cx); else if (c.startsWith("agent-")) { this.agent = c.slice(6); cx.notify(); } } });
      return;
    }
    if (p?.issue) {
      // This copy is the details dialog for one issue.
      this.detailKey = p.issue; this.overlay = p.overlay; this.site = p.site; this.linkInit("issue");
      if (!checking()) this.loadDetail(cx);
      return;
    }
    this.view = "mine"; this.issues = []; this.error = null; this.loading = false; this.query = "";
    this.input = InputState.new({ placeholder: "ABC-123, text, or JQL…" });
    this.filterName = InputState.new({ placeholder: "Name (optional)" });
    this.filterName.on("submit", (_e, cx) => this.saveFilter(cx));
    this.input.on("submit", (_e, cx) => { this.query = this.input.value().trim(); this.load(cx); });
    this.input.on("change", (_e, cx) => {
      const v = this.input.value().trim();
      this.hasText = !!v;
      if (!v && this.query) { this.query = ""; this.load(cx); }
      cx.notify();
    });
    try { this.tool = localStorage.getItem("jira.tool") || "jira"; } catch { this.tool = "jira"; }
    this.ghInit(cx);
    if (checking()) return;
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "toggle") this.toggle(); else if (c === "filter") this.menu = !this.menu; else if (c === "saved-filters") { this.fmenu = !this.fmenu; this.menu = false; } else if (c.startsWith("send-")) { const i = this.issues.find(x => x.key === c.slice(5)); if (i) this.openSend(i); } else if (c.startsWith("show-")) this.showDetail(c.slice(5)); else if (c.startsWith("pr-")) { const m = c.slice(3).match(/^(.+)#(\d+)$/); if (m) this.openPR(m[1], Number(m[2])); } else if (c.startsWith("prsend-")) { const pr = (this.prs || []).find(x => `${x.repository.nameWithOwner}#${x.number}` === c.slice(7)); if (pr) this.sendPR(pr); } else if (c === "gh-settings") this.openGhSettings(); else if (c === "tool-github" || c === "tool-jira") this.setTool(c.slice(5)); cx.notify(); } });
    this.load(cx);
    cx.timer.every(120000, cx => this.load(cx));
  }

  jql() {
    const q = this.query;
    if (!q) return viewJql(this.view);
    const [, body, order] = q.match(/^([\s\S]*?)\s*(\border by\b[\s\S]*)?$/i);
    const where = isJql(q) ? `(${body})` : `text ~ "${body.replace(/["\\]/g, "\\$&")}"`;
    const scope = searchScope(this.view) ? `${searchScope(this.view)} AND ` : "";
    return `${scope}${where} ${order || "ORDER BY priority DESC, created DESC"}`;
  }

  load(cx) {
    if (!enabled("jira")) return;
    cx.spawn(async cx => {
      this.loading = true; cx.notify();
      try {
        const c = await helper("token");
        if (c.error === "no-app" || c.error === "no-login") { this.issues = []; this.error = c.error; return; }
        if (c.error) { this.issues = []; this.error = c.error; return; }
        this.site = c.site;
        const api = `https://api.atlassian.com/ex/jira/${c.cloud_id}/rest/api/3`;
        const headers = { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" };
        const key = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(this.query) ? this.query.toUpperCase() : null;
        const url = key
          ? `${api}/issue/${key}?fields=${FIELDS}`
          : `${api}/search/jql?maxResults=50&fields=${FIELDS}&jql=${encodeURIComponent(this.jql())}`;
        const r = await fetch(url, { headers });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          this.issues = [];
          this.error = r.status === 401 ? "no-login" : (body.errorMessages || []).join(" ") || `Jira returned ${r.status}`;
          return;
        }
        this.issues = key ? [body] : (body.issues || []).sort(byPriority);
        this.error = null; this.at = new Date();
      } catch (e) {
        this.issues = []; this.error = String(e?.message || e);
      } finally {
        this.loading = false; cx.notify();
      }
    });
  }

  openSend(issue) {
    const f = issue.fields || {};
    this.openSendItem({ key: issue.key, summary: f.summary || "", icon: typeIcon(f.issuetype), tint: false, line: ticketLine(issue, this.site) });
  }

  openSendItem(item) {
    openOverlay({ mod: "work", props: { send: item }, kind: "dialog", width: 540, height: 470 });
  }

  doSend(cx) {
    this.stopDictation();
    sendLog(`click send ${this.sendIssue?.key} agent=${this.agent}`);
    const target = liveAgents().find(a => a.name.toLowerCase() === this.agent.toLowerCase());
    if (!target) { this.sendError = `${this.agent} isn't running. Pick another agent.`; cx.notify(); return; }
    const extra = this.prompt.value().trim();
    const text = this.sendIssue.line + (extra ? `\n\n${extra}` : "");
    if (this.makeDefault) setShared("jira.send", { agent: target.name });
    this.sending = true; this.sendError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await hc(["send", target.address, text]);
        sendLog(`send ${this.sendIssue.key} -> ${target.name} (${target.address}) code=${r.code} out=${(r.stdout || "").trim()} err=${(r.stderr || "").trim()}`);
        if (r.code !== 0) { this.sendError = (r.stderr || r.stdout || "Send failed").trim(); return; }
        notify({ title: `Sent ${this.sendIssue.key} to ${target.name}`, body: extra || this.sendIssue.summary || "", level: "info", timeout: 4000 });
        closeOverlay(this.overlay);
      } catch (e) {
        sendLog(`send ${this.sendIssue.key} threw: ${e?.stack || e}`);
        this.sendError = `Send failed: ${e?.message || e}`;
      } finally {
        this.sending = false; cx.notify();
      }
    });
  }

  renderSend() {
    const t = theme(), i = this.sendIssue, agents = liveAgents();
    const cur = agents.find(a => a.name.toLowerCase() === this.agent.toLowerCase());
    const label = text => div().pt(14).pb(6).text_size(11).font_semibold().text_color(t.dim).child(text);
    const picker = h_flex().id("a-pick").h(34).px(10).gap(8).items_center().rounded(7).border(1)
      .border_color(this.agentMenu ? t.accent : t.input).bg(t.background).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.agentMenu = !this.agentMenu; cx.notify(); })
      .child(avatar(this.agent, 22))
      .child(div().flex_1().text_size(12.5).child(this.agent))
      .child(div().text_size(11).text_color(cur ? t.dim : t.blocked).child(cur ? cur.status || "" : "not running"))
      .child(div().text_size(10).text_color(t.dim).child(this.agentMenu ? "▴" : "▾"));
    const menu = v_flex().mt(4).p(4).rounded(8).border(1).border_color(t.border).bg(t.popover)
      .children(agents.map(a => {
        const sel = a.name.toLowerCase() === this.agent.toLowerCase();
        return h_flex().id(`a-${a.name}`).px(8).py(6).gap(8).items_center().rounded(5)
          .when(sel, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.agent = a.name; this.agentMenu = false; this.makeDefault = false; this.sendError = null; cx.notify(); })
          .child(avatar(a.name, 20))
          .child(div().flex_1().text_size(12.5).child(a.name))
          .child(div().text_size(11).text_color(t.dim).child(a.status || ""))
          .child(div().w(14).text_size(12).text_color(t.accent).child(sel ? "✓" : ""));
      }));
    return v_flex().size_full().bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(18).h(48).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13.5).font_semibold().child("Send to agent"))
        .child(div().flex_1())
        .child(this.icon("x-close", "✕", () => { this.stopDictation(); closeOverlay(this.overlay); }, { size: 14 })))
      .child(v_flex().id("x-body").flex_1().overflow_y_scrollbar().px(18).pb(14)
        .child(h_flex().mt(14).p(10).gap(8).items_center().rounded(8).bg(t.surface).border(1).border_color(t.border)
          .child(i.tint ? svg(i.icon).w(16).h(16).flex_none().text_color(t.foreground) : image(i.icon).w(16).h(16).flex_none())
          .child(div().text_size(12.5).font_semibold().text_color(t.accent).child(i.key))
          .child(div().flex_1().text_size(12.5).truncate().child(i.summary || "")))
        .child(label("AGENT"))
        .child(picker)
        .when(this.agentMenu, el => el.child(menu))
        .child((() => {
          const isDefault = this.agent.toLowerCase() === defaultAgent().toLowerCase();
          const on = isDefault || this.makeDefault;
          return h_flex().id("x-default").pt(8).gap(8).items_center()
            .when(!isDefault, el => el.on_click((_e, cx) => { this.makeDefault = !this.makeDefault; cx.notify(); }))
            .child(div().w(14).h(14).flex_none().rounded(3).border(1).border_color(on ? t.accent : t.input)
              .when(on, el => el.bg(t.accent)).flex().items_center().justify_center()
              .text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
            .child(div().text_size(12).text_color(isDefault ? t.dim : t.foreground)
              .child(isDefault ? `${this.agent} is your default agent` : `Make ${this.agent} my default agent`));
        })())
        .child(label("PROMPT"))
        .child(div().p(8).rounded(7).border(1).border_color(t.input).bg(t.background)
          .child(Textarea.new(this.prompt).w_full().text_size(12.5).text_color(t.foreground)))
        .child(div().pt(8).text_size(11).text_color(t.dim).child(i.tint ? "The agent gets the repo, PR number, author, title, review and check state and link, then your prompt."
          : "The agent gets the ticket key, type, status, priority, summary and link, then your prompt."))
        .when(!!this.sendError, el => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.sendError))))
      .child(h_flex().px(18).h(56).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(this.micBtn("send", this.prompt))
        .child(div().flex_1())
        .child(this.action("x-cancel", "Cancel", () => { this.stopDictation(); closeOverlay(this.overlay); }, false))
        .child(this.action("x-send", `➤ Send to ${this.agent}`, cx => this.doSend(cx), true)));
  }

  // ---- ticket <-> PR link bar, shared by the issue and PR dialogs ----
  linkInit(view) {
    this.linkView = view; this.linkOn = linkCfg().on; this.links = []; this.linkBusy = 0;
    this.issueCache = new Map(); this.prCache = new Map(); this.linked = new Set();
  }
  addLinks(list) {
    for (const l of list) if (!this.links.some(x => x.id === l.id)) this.links.push(l);
    this.links.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "issue" ? -1 : 1));
  }
  prLink(p) {
    const repo = p.repository.nameWithOwner;
    return { id: `pr:${repo}#${p.number}`, kind: "pr", repo, number: p.number, label: `${repo.split("/")[1]}#${p.number}`, color: prColor(p) };
  }
  // Finds the PRs that name this ticket (once per key).
  linkIssue(key, cx) {
    if (!this.linkOn || checking() || this.linked.has(key)) return;
    this.linked.add(key); this.addLinks([{ id: `issue:${key}`, kind: "issue", key, label: key }]);
    this.linkBusy++;
    cx.spawn(async cx => {
      try { this.addLinks((await prsForKey(key)).map(p => this.prLink(p))); } catch {}
      this.linkBusy--; cx.notify();
    });
  }
  // Finds the tickets a PR names, keeps only keys Jira knows, then their other PRs.
  linkPR(pr, cx) {
    if (!this.linkOn || checking()) return;
    this.addLinks([this.prLink(pr)]);
    const keys = ticketKeys(pr, linkCfg().keys).filter(k => !this.linked.has(k));
    if (!keys.length) return;
    this.linkBusy++;
    cx.spawn(async cx => {
      try {
        const c = await helper("token");
        if (!c.error) for (const k of keys) {
          const r = await fetch(`https://api.atlassian.com/ex/jira/${c.cloud_id}/rest/api/3/issue/${k}?fields=summary`,
            { headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" } });
          if (r.ok) { this.site ||= c.site; this.linkIssue(k, cx); }
        }
      } catch {}
      this.linkBusy--; cx.notify();
    });
  }
  selectLink(l, cx) {
    if (l.kind === "issue") {
      if (this.detailKey !== l.key) this.commentBox?.set_value("");
      this.linkView = "issue"; this.detailKey = l.key; this.detailError = null; this.detail = this.issueCache.get(l.key) || null;
      if (!this.detail) this.loadDetail(cx);
    } else {
      this.linkView = "pr"; this.prRef = { repo: l.repo, number: l.number }; this.prError = null; this.pr = this.prCache.get(`${l.repo}#${l.number}`) || null;
      if (!this.pr) this.loadPR(cx);
    }
    cx.notify();
  }
  linkBar() {
    if (!this.linkOn) return div();
    const t = theme(), cur = this.linkView === "pr" ? `pr:${this.prRef?.repo}#${this.prRef?.number}` : `issue:${this.detailKey}`;
    const bar = h_flex().px(14).h(36).flex_none().gap(4).items_center().border_b(1).border_color(t.border).bg(t.surface);
    if (this.links.length < 2) return bar.child(div().px(4).text_size(11.5).text_color(t.dim).child(this.linkBusy || !this.links.length ? "Finding linked tickets and PRs…"
      : this.linkView === "pr" ? "No Jira ticket named in this PR's title or branch" : "No PR names this ticket"));
    return bar.children(this.links.map(l => {
      const on = l.id === cur;
      return h_flex().id(`lk-${l.id}`).px(9).h(26).gap(6).items_center().rounded(6).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.selectLink(l, cx))
        .child(l.kind === "issue" ? image("mods/work/icons/jira.svg").w(13).h(13) : svg(GH_ICON).w(13).h(13).text_color(t.foreground))
        .child(div().text_size(12).font_semibold().text_color(on ? t.foreground : t.muted).child(l.label))
        .when(!!l.color, el => el.child(div().w(7).h(7).rounded(4).bg(l.color)));
    })).when(this.linkBusy > 0, el => el.child(div().pl(6).text_size(11).text_color(t.dim).child("…")));
  }

  showDetail(key) {
    openOverlay({ mod: "work", props: { issue: key, site: this.site }, kind: "dialog", width: 1000, height: 760 });
  }

  loadDetail(cx) {
    cx.spawn(async cx => {
      try {
        const c = await helper("token");
        if (c.error) { this.detailError = c.error === "no-login" ? "Sign in from the Jira panel first." : c.error; return; }
        this.site = c.site;
        const f = "summary,status,assignee,reporter,priority,issuetype,created,updated,description,labels,parent,comment,customfield_10020";
        const r = await fetch(`https://api.atlassian.com/ex/jira/${c.cloud_id}/rest/api/3/issue/${this.detailKey}?fields=${f}&expand=renderedFields`,
          { headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" } });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { this.detailError = (body.errorMessages || []).join(" ") || `Jira returned ${r.status}`; return; }
        // Subtasks and an epic's child issues both have this issue as parent.
        const kids = await fetch(`https://api.atlassian.com/ex/jira/${c.cloud_id}/rest/api/3/search/jql?maxResults=100&fields=summary,status,priority,issuetype,assignee&jql=${encodeURIComponent(`parent = ${this.detailKey} ORDER BY created ASC`)}`,
          { headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json" } }).then(x => x.ok ? x.json() : {}).catch(() => ({}));
        body.children = kids.issues || [];
        this.detail = body;
        this.issueCache?.set(this.detailKey, body);
        this.linkIssue(this.detailKey, cx);
      } catch (e) {
        this.detailError = String(e?.message || e);
      } finally {
        cx.notify();
      }
    });
  }

  // ---- writes from the issue dialog (need write:jira-work on the OAuth login) ----
  async jiraCall(method, path, body) {
    const c = await helper("token");
    if (c.error) throw new Error(c.error === "no-login" ? "Sign in from the Jira panel first." : c.error);
    const r = await fetch(`https://api.atlassian.com/ex/jira/${c.cloud_id}/rest/api/3${path}`, {
      method, headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    const out = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) throw new Error("Jira refused the change. The panel's sign-in needs write:jira-work: add it to your OAuth app, then sign out and back in (Settings → Jira).");
    if (!r.ok) throw new Error((out.errorMessages || []).concat(Object.values(out.errors || {})).join(" ") || `Jira returned ${r.status}`);
    return out;
  }
  openStatusMenu(cx) {
    this.statusMenu = !this.statusMenu; this.writeError = null;
    if (!this.statusMenu) { cx.notify(); return; }
    this.transitions = null; cx.notify();
    cx.spawn(async cx => {
      try { this.transitions = (await this.jiraCall("GET", `/issue/${this.detailKey}/transitions`)).transitions || []; }
      catch (e) { this.writeError = String(e?.message || e); this.statusMenu = false; }
      cx.notify();
    });
  }
  doTransition(tr, cx) {
    this.busyWrite = true; cx.notify();
    cx.spawn(async cx => {
      try { await this.jiraCall("POST", `/issue/${this.detailKey}/transitions`, { transition: { id: tr.id } }); this.statusMenu = false; this.loadDetail(cx); }
      catch (e) { this.writeError = String(e?.message || e); }
      this.busyWrite = false; cx.notify();
    });
  }
  postComment(cx) {
    const text = this.commentBox.value().trim();
    if (!text || this.busyWrite) return;
    this.stopDictation();
    const doc = { type: "doc", version: 1, content: text.split(/\n{2,}/).map(p => ({ type: "paragraph",
      content: p.split("\n").flatMap((l, i) => [...(i ? [{ type: "hardBreak" }] : []), ...(l ? [{ type: "text", text: l }] : [])]) })) };
    this.busyWrite = true; this.writeError = null; cx.notify();
    cx.spawn(async cx => {
      try { await this.jiraCall("POST", `/issue/${this.detailKey}/comment`, { body: doc }); this.commentBox.set_value(""); this.loadDetail(cx); }
      catch (e) { this.writeError = String(e?.message || e); }
      this.busyWrite = false; cx.notify();
    });
  }

  renderDetail() {
    const t = theme(), d = this.detail, f = d?.fields || {}, rf = d?.renderedFields || {};
    const browse = () => this.site && openUrl(`${this.site}/browse/${this.detailKey}`);
    const link = url => openUrl(url.startsWith("/") && this.site ? this.site + url : url);
    const head = h_flex().px(18).h(48).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
      .when(!!d, el => el.child(image(typeIcon(f.issuetype)).w(16).h(16).flex_none())
        .child(div().text_size(12).text_color(t.muted).child(f.issuetype?.name || ""))
        .child(div().text_size(12).text_color(t.dim).child("/")))
      .child(div().id("d-key").text_size(12.5).font_semibold().text_color(t.accent).hover(s => s.underline())
        .on_click(browse).child(this.detailKey))
      .child(div().flex_1())
      .when(!!d, el => el.child(this.action("d-send", "➤ Send to agent", () => this.openSend(d), true)))
      .child(this.action("d-open", "Open in Jira ↗", browse, false))
      .child(this.icon("d-close", "✕", () => { this.stopDictation(); closeOverlay(this.overlay); }, { size: 14 }));
    if (!d) {
      return v_flex().size_full().bg(t.popover).text_color(t.foreground).child(head).child(this.linkBar())
        .child(div().p(18).text_size(12.5).text_color(this.detailError ? t.blocked : t.dim).child(this.detailError || "Loading…"));
    }
    const fmt = iso => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
    const sprint = (f.customfield_10020 || []).map(s => s.name).pop();
    const color = this.statusColor(f.status?.statusCategory?.key, f.status?.name);
    const label = text => div().pb(5).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const person = (p, size = 22) => h_flex().gap(8).items_center()
      .child(avatar(p?.displayName, size))
      .child(div().text_size(12.5).truncate().child(p?.displayName || "Unassigned"));
    const field = (k, v) => v_flex().pb(14).child(label(k)).child(typeof v === "string" ? div().text_size(12.5).child(v) : v);
    const side = v_flex().w(250).flex_none().p(18).border_l(1).border_color(t.border).bg(t.surface)
      .child(field("Status", v_flex().gap(4)
        .child(h_flex().child(h_flex().id("d-status").gap(6).items_center().px(10).py(4).rounded(6).bg(t.raised)
          .border(1).border_color(this.statusMenu ? t.accent : t.raised).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.openStatusMenu(cx))
          .child(div().w(8).h(8).rounded(4).bg(color)).child(div().text_size(12).font_semibold().child(f.status?.name || ""))
          .child(div().text_size(10).text_color(t.dim).child(this.statusMenu ? "▴" : "▾"))))
        .when(!!this.statusMenu, el => el.child(v_flex().p(4).rounded(8).border(1).border_color(t.border).bg(t.popover)
          .children(this.transitions == null ? [div().px(8).py(5).text_size(12).text_color(t.dim).child("Loading…")]
            : this.transitions.map(tr => h_flex().id(`tr-${tr.id}`).px(8).py(5).gap(8).items_center().rounded(5).hover(s => s.bg(t.hover))
              .on_click((_e, cx) => this.doTransition(tr, cx))
              .child(div().w(8).h(8).flex_none().rounded(4).bg(this.statusColor(tr.to?.statusCategory?.key, tr.to?.name)))
              .child(div().flex_1().text_size(12).child(tr.to?.name || tr.name))
              .when(tr.name !== tr.to?.name, el => el.child(div().text_size(10.5).text_color(t.dim).child(tr.name)))))))))
      .child(field("Assignee", person(f.assignee)))
      .child(field("Reporter", person(f.reporter)))
      .child(field("Priority", f.priority?.name ? h_flex().child(prioPill(f.priority.name, 12)) : "—"))
      .child(field("Sprint", sprint || "—"))
      .when(!!f.parent, el => el.child(field("Parent", h_flex().id("d-parent").gap(6).items_center().hover(s => s.underline())
        .on_click(() => this.site && openUrl(`${this.site}/browse/${f.parent.key}`))
        .child(image(typeIcon(f.parent.fields?.issuetype)).w(14).h(14).flex_none())
        .child(div().text_size(12).text_color(t.accent).child(f.parent.key))
        .child(div().text_size(12).truncate().child(f.parent.fields?.summary || "")))))
      .when((f.labels || []).length > 0, el => el.child(field("Labels", h_flex().flex_wrap().gap(4).children(f.labels.map(l =>
        div().px(7).py(1).rounded(4).bg(t.raised).text_size(11).child(l))))))
      .child(div().h(1).my(6).bg(t.border))
      .child(field("Created", fmt(f.created)))
      .child(field("Updated", `${fmt(f.updated)} · ${ago(f.updated)} ago`));
    const comments = (f.comment?.comments || []).map((c, i) => ({ ...c, html: rf.comment?.comments?.[i]?.body })).reverse().slice(0, 10);
    const heading = text => div().pt(22).pb(10).text_size(13).font_semibold().child(text);
    const main = v_flex().id("d-main").flex_1().min_w(0).overflow_y_scrollbar().px(24).pb(24)
      .child(div().pt(18).text_size(19).font_semibold().line_height(1.3).child(f.summary || ""))
      .child(heading("Description"))
      .child(rf.description
        ? TextView.html("d-desc", rf.description).text_size(13).selectable(true).on_link_click(link)
        : div().text_size(12.5).text_color(t.dim).child("No description."))
      .when((d.children || []).length > 0, el => el.child(heading(`${f.issuetype?.subtask === false && f.issuetype?.hierarchyLevel > 0 ? "Child issues" : "Subtasks"} · ${d.children.length}`))
        .child(v_flex().rounded(8).border(1).border_color(t.border).children(d.children.map((k, i) => {
          const kf = k.fields || {}, done = kf.status?.statusCategory?.key === "done";
          return h_flex().id(`d-sub-${k.key}`).px(10).py(7).gap(8).items_center().when(i > 0, el => el.border_t(1).border_color(t.border))
            .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.selectLink({ kind: "issue", key: k.key }, cx))
            .child(image(typeIcon(kf.issuetype)).w(14).h(14).flex_none())
            .child(div().flex_none().text_size(12).font_semibold().text_color(t.accent).when(done, el => el.line_through()).child(k.key))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(done ? t.dim : t.foreground).child(kf.summary || ""))
            .when(!!kf.priority?.name, el => el.child(prioPill(kf.priority.name)))
            .child(h_flex().flex_none().gap(5).items_center().px(7).py(1).rounded(4).bg(t.raised)
              .child(div().w(7).h(7).rounded(4).bg(this.statusColor(kf.status?.statusCategory?.key, kf.status?.name)))
              .child(div().text_size(11).child(kf.status?.name || "")))
            .child(avatar(kf.assignee?.displayName, 18));
        }))))
      .child(heading(`Comments · ${f.comment?.total ?? comments.length}`))
      .when(!!this.writeError, el => el.child(div().mb(10).p(10).rounded(8).border(1).border_color(t.blocked).text_size(12).text_color(t.blocked).child(this.writeError)))
      .child(v_flex().pb(16).gap(8)
        .child(div().p(8).rounded(8).border(1).border_color(t.input).bg(t.background)
          .child(Textarea.new(this.commentBox).w_full().text_size(12.5).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(this.micBtn("comment", this.commentBox))
          .child(div().flex_1())
          .child(this.action("d-comment", this.busyWrite ? "Saving…" : "Comment", cx => this.postComment(cx), true))))
      .children(comments.length ? comments.map((c, i) => h_flex().items_start().gap(10).pb(14)
        .child(div().pt(2).child(avatar(c.author?.displayName, 28)))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(12.5).font_semibold().child(c.author?.displayName || ""))
            .child(div().text_size(11).text_color(t.dim).child(`${ago(c.created)} ago`)))
          .child(div().p(10).rounded(8).bg(t.surface).border(1).border_color(t.border)
            .child(TextView.html(`d-c-${i}`, c.html || "").text_size(12.5).selectable(true).on_link_click(link)))))
        : [div().text_size(12.5).text_color(t.dim).child("No comments yet.")]);
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).child(head).child(this.linkBar())
      .child(h_flex().flex_1().min_h(0).items_stretch().child(main).child(side));
  }

  login(cx) {
    if (this.signing) return;
    cx.spawn(async cx => {
      this.signing = true; cx.notify();
      const r = await helper("login", 300000).catch(e => ({ error: String(e?.message || e) }));
      this.signing = false;
      if (r.error) { this.error = "no-login"; this.loginError = r.error; cx.notify(); return; }
      this.loginError = null;
      this.load(cx);
    });
  }

  editApp() {
    const tpl = '{ "client_id": "paste-client-id", "client_secret": "paste-secret" }';
    if (window().platform === "windows") {
      const p = `${DIR()}/app.json`.replace(/\//g, "\\");
      exec("powershell", ["-NoProfile", "-Command",
        `if (-not (Test-Path -LiteralPath '${p}')) { Set-Content -LiteralPath '${p}' -Value '${tpl}' -Encoding UTF8 }; Start-Process notepad -ArgumentList '"${p}"'`]);
    } else {
      const p = `${DIR()}/app.json`;
      exec("/bin/sh", ["-c", '[ -e "$1" ] || { umask 077; printf "%s\\n" "$2" > "$1"; }; open -t "$1"', "sh", p, tpl]);
    }
  }

  collapsed() { return (this.size?.width ?? 999) < 90; }

  toggle() {
    if (this.collapsed()) {
      let w = 340;
      try { w = Number(localStorage.getItem("jira.width")) || 340; } catch {}
      run("layout.resize", { id: "work-panel", px: w });
    } else {
      try { localStorage.setItem("jira.width", String(Math.round(this.size?.width || 340))); } catch {}
      run("layout.resize", { id: "work-panel", px: STRIP });
    }
  }

  icon(id, label, on, { size = 15, active = false, title } = {}) {
    const t = theme();
    return div().id(id).w(30).h(28).flex().items_center().justify_center().rounded(6).text_size(size)
      .text_color(active ? t.foreground : t.muted).when(active, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => on(cx)).child(label);
  }

  tab(id, label, on, active) {
    const t = theme();
    return div().id(id).px(9).py(3).rounded(6).text_size(12)
      .text_color(active ? t.foreground : t.muted).when(active, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => on(cx)).child(label);
  }

  // ---- dictation: ~/.herdr-jira/stt.py runs Chrome's Web Speech API in a small app window ----
  micBtn(id, box) {
    const t = theme(), on = this.dictating === id;
    return h_flex().id(`mic-${id}`).h(30).px(9).gap(6).items_center().rounded(7).border(1)
      .border_color(on ? "#e5484d" : t.input).when(on, el => el.bg("#e5484d26")).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.dictate(id, box, cx))
      .child(svg("mods/work/icons/mic.svg").w(14).h(14).text_color(on ? "#e5484d" : t.muted))
      .when(on, el => el.child(div().text_size(12).font_semibold().text_color("#e5484d").child("Listening… click to stop")));
  }
  dictate(id, box, cx) {
    const STT = "http://127.0.0.1:8766";
    if (this.dictating) { if (this.dictating === id) fetch(`${STT}/stop`, { method: "POST" }).catch(() => {}); return; }
    this.dictating = id; this.dictDiscard = false; this[id === "send" ? "sendError" : "writeError"] = null;
    const base = box.value(), sep = base && !/\s$/.test(base) ? " " : "";
    const put = text => { if (text) box.set_value(base + sep + text); };
    const poll = this.dictPoll = cx.timer.every(300, cx => { fetch(`${STT}/state`).then(r => r.json()).then(s => { put(s.text); cx.notify(); }).catch(() => {}); });
    cx.spawn(async cx => {
      let out;
      try {
        const r = await exec(window().platform === "windows" ? "python" : "python3", [`${DIR()}/stt.py`], { timeout: 610000 });
        try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { out = { error: (r.stderr || r.stdout || "dictation failed").trim().split("\n").pop() }; }
      } catch (e) { out = { error: String(e?.message || e) }; }
      poll.cancel();
      if (this.dictDiscard) {} else if (out.error) this[id === "send" ? "sendError" : "writeError"] = `Dictation: ${out.error}`; else put(out.text);
      this.dictating = null; cx.notify();
    });
    cx.notify();
  }

  // Sending, commenting or closing the dialog ends a running dictation; what's already in the box stays as is.
  stopDictation() {
    if (!this.dictating) return;
    this.dictDiscard = true; this.dictPoll?.cancel();
    exec(window().platform === "windows" ? "python" : "python3", [`${DIR()}/stt.py`, "stop"], { timeout: 5000 }).catch(() => {});
  }
  close() { this.stopDictation(); }

  action(id, label, on, primary) {
    const t = theme();
    return div().id(id).px(12).py(7).rounded(7).text_size(12.5).font_semibold()
      .when(primary, el => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, el => el.border(1).border_color(t.input).text_color(t.foreground))
      .hover(s => s.opacity(0.85)).on_click((_e, cx) => on(cx)).child(label);
  }

  setTool(tool) {
    this.tool = tool;
    try { localStorage.setItem("jira.tool", tool); } catch {}
    if (this.collapsed()) this.toggle();
  }

  // Right-edge toolbar: each icon opens its tool; clicking the open tool's icon collapses to the toolbar.
  toolbar() {
    const t = theme(), open = !this.collapsed();
    const btn = (id, tool, icon, count, bad, loading) => {
      const active = open && this.tool === tool;
      return v_flex().id(id).w(36).py(6).gap(3).items_center().rounded(8)
        .when(active, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { if (active) this.toggle(); else this.setTool(tool); cx.notify(); })
        .child(icon)
        .child(div().min_w(22).px(4).rounded(5).bg(t.raised).flex().justify_center().text_size(10.5).font_semibold()
          .text_color(bad ? t.blocked : active ? t.foreground : t.muted).child(loading ? "…" : bad ? "!" : String(count)));
    };
    return v_flex().w(STRIP).flex_none().h_full().items_center().pt(8).gap(6).bg(t.chrome).border_l(1).border_color(t.border)
      .when(enabled("jira"), el => el.child(btn("tb-jira", "jira", image("mods/work/icons/jira.svg").w(18).h(18), this.issues.length, !!this.error, this.loading)))
      .when(enabled("github"), el => el.child(btn("tb-github", "github", svg(GH_ICON).w(18).h(18).text_color(t.foreground), (this.prs || []).length, !!this.ghError && this.ghError !== "no-repos", this.ghLoading)))
      .child(div().flex_1())
      .child(this.icon("tb-refresh", "↻", cx => { this.load(cx); this.ghLoad(cx); }, { size: 16 }))
      .child(this.icon("tb-settings", "⚙", () => this.openGhSettings(), { size: 16 }))
      .child(div().pb(8).child(v_flex().id("tb-peerlink").w(36).py(6).items_center().rounded(8).hover(s => s.bg(t.hover))
        .on_click(() => { if (!checking()) openPeerlink(); }).child(image("mods/work/icons/peerlink.svg").w(18).h(18))));
  }

  // To Do grey, In Progress blue, In Review / QA purple, Done green.
  statusColor(cat, name = "") {
    if (/blocked/i.test(name)) return "#F87168";
    if (/needs more info/i.test(name)) return "#FEA362";
    if (/review|qa/i.test(name)) return "#9F8FEF";
    return cat === "done" ? "#4BCE97" : cat === "indeterminate" ? "#579DFF" : "#8993A4";
  }

  row(i) {
    const t = theme(), f = i.fields || {};
    const who = this.view !== "mine" ? f.assignee?.displayName || "Unassigned" : "";
    return h_flex().id(`i-${i.key}`).items_stretch().rounded(6).hover(s => s.bg(t.hover)).on_click(() => this.showDetail(i.key))
      .child(div().w(3).my(6).flex_none().rounded(2).bg(this.statusColor(f.status?.statusCategory?.key, f.status?.name)))
      .child(v_flex().flex_1().min_w(0).pl(9).pr(8).py(7).gap(3)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(image(typeIcon(f.issuetype)).w(14).h(14).flex_none())
          .child(div().text_color(t.muted).child(f.issuetype?.name || ""))
          .child(div().id(`k-${i.key}`).text_color(t.accent).font_semibold().hover(s => s.underline())
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.site && openUrl(`${this.site}/browse/${i.key}`); })
            .child(i.key))
          .child(div().flex_1())
          .child(div().text_color(t.dim).text_size(10.5).child(f.updated ? ago(f.updated) : ""))
          .when(!!sprintOf(f), el => el.child(sprintChip(sprintOf(f), t)))
          .when(!!f.priority?.name, el => el.child(prioPill(f.priority.name)))
          .child(div().id(`send-${i.key}`).w(22).h(20).flex().items_center().justify_center().rounded(4).text_size(12)
            .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.accent))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.openSend(i); })
            .child("➤")))
        .child(div().text_size(12.5).line_height(1.35).text_color(t.foreground).child(f.summary || ""))
        .when(!!who, el => el.child(h_flex().gap(6).items_center().pt(1)
          .child(avatar(f.assignee?.displayName, 16))
          .child(div().text_size(10.5).text_color(t.muted).truncate().child(who)))));
  }

  picked() { try { return new Set(JSON.parse(localStorage.getItem("jira.statuses") || "[]")); } catch { return new Set(); } }

  pick(name, cx) {
    const s = this.picked();
    s.has(name) ? s.delete(name) : s.add(name);
    try { localStorage.setItem("jira.statuses", JSON.stringify([...s])); } catch {}
    cx.notify();
  }

  // Saved searches (shared "jira.filters": [{name, jql}]), from the funnel button beside the search box.
  saveFilter(cx) {
    const jql = this.input.value().trim();
    if (!jql) return;
    const name = this.filterName.value().trim() || jql;
    const list = (shared("jira.filters") || []).filter(f => f.name !== name);
    setShared("jira.filters", [...list, { name, jql }]);
    this.filterName.set_value(""); this.query = jql; this.load(cx); cx.notify();
  }
  runFilter(f, cx) {
    this.input.set_value(f.jql); this.hasText = true; this.query = f.jql; this.fmenu = false; this.load(cx); cx.notify();
  }
  filterMenu() {
    const t = theme(), saved = shared("jira.filters") || [], cur = this.input.value().trim();
    const row = (f, i) => h_flex().id(`sf-${i}`).px(8).py(5).gap(8).items_center().rounded(5).hover(s => s.bg(t.hover))
      .when(this.query === f.jql, el => el.bg(t.selected))
      .on_click((_e, cx) => this.runFilter(f, cx))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(12).truncate().child(f.name))
        .when(f.name !== f.jql, el => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(f.jql))))
      .child(div().id(`sf-del-${i}`).w(20).h(20).flex_none().flex().items_center().justify_center().rounded(10)
        .text_size(11).text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.blocked))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); setShared("jira.filters", saved.filter(x => x !== f)); cx.notify(); })
        .child("✕"));
    return v_flex().mx(10).mb(8).p(4).rounded(8).border(1).border_color(t.border).bg(t.popover)
      .child(div().px(8).pt(4).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child("SAVED FILTERS"))
      .children(saved.length ? saved.map(row) : [div().px(8).py(5).text_size(12).text_color(t.dim).child("None yet. Type JQL above, then save it here.")])
      .child(h_flex().px(4).pt(6).pb(2).mt(4).gap(6).items_center().border_t(1).border_color(t.border)
        .child(h_flex().flex_1().h(26).px(6).rounded(5).border(1).border_color(t.input).bg(t.background).items_center()
          .child(Input.new(this.filterName).flex_1().h_full().text_size(11.5).text_color(t.foreground)))
        .child(h_flex().id("sf-save").px(10).h(26).items_center().rounded(5).text_size(11.5).font_semibold()
          .when(!!cur, el => el.bg(t.accent).text_color(t.accent_foreground).hover(s => s.opacity(0.9)))
          .when(!cur, el => el.bg(t.raised).text_color(t.dim))
          .on_click((_e, cx) => this.saveFilter(cx))
          .child("Save search")));
  }

  // Status filter: an All button plus a dropdown checklist (one or many statuses).
  pills(all) {
    const t = theme(), on = this.picked();
    const chosen = all.filter(g => on.has(g.name)), none = !chosen.length;
    const summary = none ? "Status" : chosen.length === 1 ? chosen[0].name : `${chosen.length} statuses`;
    const bar = h_flex().gap(6).px(10).pb(6).items_center()
      .child(h_flex().id("f-all").px(10).h(26).items_center().rounded(6).border(1).text_size(11.5)
        .border_color(none ? t.accent : t.border).when(none, el => el.bg(t.selected))
        .text_color(none ? t.foreground : t.muted).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { try { localStorage.setItem("jira.statuses", "[]"); } catch {} this.menu = false; cx.notify(); })
        .child(`All · ${this.issues.length}`))
      .child(h_flex().id("f-menu").flex_1().min_w(0).px(10).h(26).gap(6).items_center().rounded(6).border(1).text_size(11.5)
        .border_color(this.menu || !none ? t.accent : t.border).when(!none, el => el.bg(t.selected))
        .text_color(none ? t.muted : t.foreground).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.menu = !this.menu; this.gmenu = false; cx.notify(); })
        .children(chosen.slice(0, 4).map(g => div().w(7).h(7).flex_none().rounded(4).bg(this.statusColor(g.cat, g.name))))
        .child(div().flex_1().truncate().child(summary))
        .child(div().text_size(10).text_color(t.dim).child(this.menu ? "▴" : "▾")))
      .child(this.groupButton());
    if (this.gmenu) return v_flex().child(bar).child(this.groupMenu());
    if (!this.menu) return bar;
    const item = g => {
      const sel = on.has(g.name);
      return h_flex().id(`f-${g.name}`).px(8).py(5).gap(8).items_center().rounded(5).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.pick(g.name, cx))
        .child(div().w(14).h(14).flex_none().rounded(3).border(1).border_color(sel ? t.accent : t.input)
          .when(sel, el => el.bg(t.accent)).flex().items_center().justify_center()
          .text_size(10).text_color(t.accent_foreground).child(sel ? "✓" : ""))
        .child(div().w(8).h(8).flex_none().rounded(4).bg(this.statusColor(g.cat, g.name)))
        .child(div().flex_1().text_size(12).child(g.name))
        .child(div().text_size(11).text_color(t.dim).child(String(g.items.length)));
    };
    return v_flex().child(bar).child(
      v_flex().mx(10).mb(8).p(4).rounded(8).border(1).border_color(t.border).bg(t.popover)
        .children(all.map(item))
        .child(h_flex().px(8).pt(6).pb(2).mt(2).gap(12).border_t(1).border_color(t.border).text_size(11.5)
          .child(div().id("f-clear").text_color(t.muted).hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => { try { localStorage.setItem("jira.statuses", "[]"); } catch {} cx.notify(); }).child("Clear"))
          .child(div().flex_1())
          .child(div().id("f-done").text_color(t.accent).font_semibold()
            .on_click((_e, cx) => { this.menu = false; cx.notify(); }).child("Done"))));
  }

  groups() {
    const by = new Map();
    for (const i of this.issues) {
      const s = i.fields?.status, name = s?.name || "Unknown";
      if (!by.has(name)) by.set(name, { name, mode: "status", cat: s?.statusCategory?.key, items: [] });
      by.get(name).items.push(i);
    }
    return [...by.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }

  // The list's grouping: status (the default), assignee or epic, remembered in "jira.groupBy".
  groupBy() { try { return localStorage.getItem("jira.groupBy") || "status"; } catch { return "status"; } }
  setGroupBy(mode, cx) { try { localStorage.setItem("jira.groupBy", mode); } catch {} this.gmenu = false; cx.notify(); }

  // The issues the status filter lets through, grouped by the chosen key.
  grouped() {
    const mode = this.groupBy(), on = this.picked(), status = this.groups();
    if (mode === "status") { const shown = status.filter(g => on.has(g.name)); return shown.length ? shown : status; }
    const keep = status.some(g => on.has(g.name)) ? i => on.has(i.fields?.status?.name || "Unknown") : () => true;
    const isEpic = it => it?.hierarchyLevel === 1 || /^epic$/i.test(it?.name || "");
    const by = new Map();
    for (const i of this.issues.filter(keep)) {
      const f = i.fields || {};
      let id, name, last = false, epic = null;
      if (mode === "assignee") {
        id = f.assignee?.accountId || ""; name = f.assignee?.displayName || "Unassigned"; last = !f.assignee;
      } else {
        epic = isEpic(f.issuetype) ? { key: i.key, summary: f.summary } : isEpic(f.parent?.fields?.issuetype) ? { key: f.parent.key, summary: f.parent.fields?.summary } : null;
        id = epic?.key || ""; name = epic ? `${epic.key} ${epic.summary || ""}`.trim() : "No epic"; last = !epic;
      }
      if (!by.has(id)) by.set(id, { id: `${mode}:${id}`, name, mode, last, epic, items: [] });
      by.get(id).items.push(i);
    }
    return [...by.values()].sort((a, b) => a.last - b.last || a.name.localeCompare(b.name));
  }

  // The "Group" button beside the status filter, with its menu.
  groupButton() {
    const t = theme(), mode = this.groupBy();
    return h_flex().id("g-menu").flex_none().px(10).h(26).gap(6).items_center().rounded(6).border(1).text_size(11.5)
      .border_color(this.gmenu || mode !== "status" ? t.accent : t.border).when(mode !== "status", el => el.bg(t.selected))
      .text_color(mode === "status" ? t.muted : t.foreground).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.gmenu = !this.gmenu; this.menu = false; cx.notify(); })
      .child(div().child(`By ${GROUPINGS[mode] || "status"}`))
      .child(div().text_size(10).text_color(t.dim).child(this.gmenu ? "▴" : "▾"));
  }

  groupMenu() {
    const t = theme(), mode = this.groupBy();
    return v_flex().mx(10).mb(8).p(4).rounded(8).border(1).border_color(t.border).bg(t.popover)
      .child(div().px(8).pt(4).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child("GROUP BY"))
      .children(Object.entries(GROUPINGS).map(([m, label]) => h_flex().id(`gb-${m}`).px(8).py(5).gap(8).items_center().rounded(5)
        .hover(s => s.bg(t.hover)).when(m === mode, el => el.bg(t.selected))
        .on_click((_e, cx) => this.setGroupBy(m, cx))
        .child(div().w(14).text_size(11).text_color(t.accent).child(m === mode ? "✓" : ""))
        .child(div().flex_1().text_size(12).child(label[0].toUpperCase() + label.slice(1)))));
  }

  folded(name) { try { return JSON.parse(localStorage.getItem("jira.folded") || "{}")[name] === true; } catch { return false; } }

  fold(name, cx) {
    let m = {};
    try { m = JSON.parse(localStorage.getItem("jira.folded") || "{}"); } catch {}
    m[name] = !m[name];
    try { localStorage.setItem("jira.folded", JSON.stringify(m)); } catch {}
    cx.notify();
  }

  group(g) {
    // Status groups keep their old fold keys (the bare name); assignee and epic groups use "<mode>:<id>".
    const t = theme(), key = g.id || g.name, shut = this.folded(key);
    const mark = g.mode === "assignee" ? avatar(g.last ? "" : g.name, 14)
      : g.mode === "epic" ? div().w(8).h(8).rounded(2).bg(g.last ? "#8993A4" : EPIC)
      : div().w(8).h(8).rounded(4).bg(this.statusColor(g.cat, g.name));
    return v_flex().pb(6)
      .child(h_flex().id(`g-${key}`).px(8).py(6).gap(7).items_center().rounded(6).border_b(1).border_color(t.border)
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.fold(key, cx))
        .child(div().w(10).text_size(10).text_color(t.dim).child(shut ? "▸" : "▾"))
        .child(mark)
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground)
          .child(g.mode === "status" || !g.mode ? g.name.toUpperCase() : g.name))
        .child(div().px(7).rounded(8).bg(t.raised).text_size(10.5).font_semibold().text_color(t.muted).child(String(g.items.length))))
      .when(!shut, el => el.child(v_flex().pt(4).gap(2).children(g.items.map(i => this.row(i)))));
  }

  body() {
    const t = theme();
    if (this.error === "no-login") {
      return v_flex().p(14).gap(10).text_size(12).text_color(t.muted)
        .child(div().text_color(t.foreground).font_semibold().text_size(13).child("Sign in to Jira"))
        .child(this.action("login", this.signing ? "Waiting for browser…" : "Log in with Atlassian", cx => this.login(cx), true))
        .child(div().text_size(11).text_color(t.dim).child("Opens Atlassian in your browser. Finish there and this panel loads."))
        .when(!!this.loginError, el => el.child(div().text_size(11.5).text_color(t.blocked).child(this.loginError)));
    }
    if (this.error === "no-app") {
      return v_flex().p(14).gap(10).text_size(12).text_color(t.muted)
        .child(div().text_color(t.foreground).font_semibold().text_size(13).child("One-time setup"))
        .child(div().child("Create an OAuth 2.0 app (callback http://localhost:8765/callback, Jira scopes read:jira-work + read:jira-user), then paste its client ID and secret."))
        .child(this.action("console", "1. Open Atlassian developer console", () => openUrl(CONSOLE_URL), false))
        .child(this.action("edit", "2. Paste client ID + secret", () => this.editApp(), false))
        .child(this.action("retry", "3. Continue", cx => this.load(cx), true));
    }
    if (this.error) return div().p(12).text_size(12).text_color(t.blocked).child(this.error);
    if (!this.issues.length) return div().p(12).text_size(12).text_color(t.dim).child(this.loading ? "Loading…" : "No issues.");
    return v_flex().px(4).pb(8).children(this.grouped().map(g => this.group(g)));
  }

  render(cx) {
    if (this.sendIssue) return this.renderSend();
    if (this.linkView === "pr") return this.renderPR();
    if (this.detailKey) return this.renderDetail();
    if (this.prRef) return this.renderPR();
    if (this.ghSettingsMode) return this.renderGhSettings();
    const t = theme();
    return h_flex().id("root").size_full().bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .when(!this.collapsed() && (enabled("jira") || enabled("github")), el => el.child(
        (this.tool === "github" && enabled("github")) || !enabled("jira") ? this.renderGithub() : this.jiraPanel()))
      .child(this.toolbar());
  }

  jiraPanel() {
    const t = theme();
    const at = this.at ? `${this.at.getHours()}:${String(this.at.getMinutes()).padStart(2, "0")}` : "";
    return v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(10).h(40).gap(4).items_center().border_b(1).border_color(t.border)
        .child(image("mods/work/icons/jira.svg").w(16).h(16).flex_none())
        .child(div().pl(2).font_semibold().text_size(13).child("Jira"))
        .child(div().w(6))
        .child(this.tab("v-mine", "Mine", cx => { this.view = "mine"; this.load(cx); }, this.view === "mine"))
        .child(this.tab("v-sprint", "Sprint", cx => { this.view = "sprint"; this.load(cx); }, this.view === "sprint"))
        .child(this.tab("v-all", "All", cx => { this.view = "all"; this.load(cx); }, this.view === "all"))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(this.loading ? "…" : at))
        .child(this.icon("refresh", "↻", cx => this.load(cx), { size: 17 })))
      .child(h_flex().px(10).py(6).child(
        h_flex().flex_1().h(28).px(8).rounded(6).border(1).border_color(t.input).bg(t.background).items_center()
          .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))
          .when(!!this.hasText || !!this.query, el => el.child(div().id("q-clear").w(20).h(20).flex_none().flex().items_center().justify_center()
            .rounded(10).text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              this.input.set_value(""); this.hasText = false;
              if (this.query) { this.query = ""; this.load(cx); } else cx.notify();
            })
            .child("✕"))))
        .child(div().id("q-filters").ml(6).w(28).h(28).flex_none().flex().items_center().justify_center().rounded(6).border(1)
          .border_color(this.fmenu ? t.accent : t.input).when(this.fmenu, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.fmenu = !this.fmenu; this.menu = false; cx.notify(); })
          .child(svg("mods/work/icons/filter.svg").w(13).h(13).text_color((shared("jira.filters") || []).some(f => f.jql === this.query) ? t.accent : t.muted))))
      .when(!!this.fmenu, el => el.child(this.filterMenu()))
      .when(!this.error && this.issues.length > 0, el => el.child(this.pills(this.groups())))
      .child(div().flex_1().id("list").overflow_y_scrollbar().child(this.body()));
  }
}

installGithub(Jira.prototype);
