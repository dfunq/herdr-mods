// GitHub tool for the right-side toolbar: open PRs in watched repos (or mine), PR details, watched-repo settings.
// All data comes from the `gh` CLI (your own login). Watched repos live in shared state "github.watch".
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, home, theme, shared, setShared, openOverlay, closeOverlay, checking, terminals, window } from "herdr";
import * as fs from "fs/promises";

export const GH_ICON = "mods/work/icons/github.svg";
const openUrl = url => window().platform === "windows" ? exec("rundll32", ["url.dll,FileProtocolHandler", url]) : exec("open", [url]);
const ago = iso => {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const AVATAR = ["#5E6AD2", "#2684FF", "#00A3BF", "#36B37E", "#FF8B00", "#E5493A", "#904EE2", "#6554C0"];
const avatar = (name, size) => div().w(size).h(size).flex_none().rounded(size / 2)
  .bg(AVATAR[[...(name || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length])
  .flex().items_center().justify_center().text_size(size * 0.42).font_semibold().text_color("#ffffff")
  .child((name || "?").slice(0, 2).toUpperCase());

const GREEN = "#4BCE97", RED = "#F87168", PURPLE = "#9F8FEF", GREY = "#8993A4", YELLOW = "#F5CD47";

// One PR's review state, as a label and color.
export function prState(pr) {
  if (pr.merged || pr.state === "MERGED") return { label: "Merged", color: PURPLE };
  if (pr.state === "CLOSED") return { label: "Closed", color: RED };
  if (pr.isDraft) return { label: "Draft", color: GREY };
  if (pr.reviewDecision === "APPROVED") return { label: "Approved", color: GREEN };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", color: RED };
  return { label: "Review required", color: "#579DFF" };
}
// Open vs draft, for PRs that are still open; null once merged or closed.
function openState(pr) {
  if (pr.state !== "OPEN" || pr.merged) return null;
  return pr.isDraft ? { label: "Draft", color: GREY } : { label: "Open", color: GREEN };
}
// PR <-> Jira linking (shared "link": {on, keys}). Keys limit matches to those Jira projects (and scope the Sprint tab); empty means any.
export const linkCfg = () => { const c = shared("link") || {}; return { on: c.on ?? true, keys: c.keys ?? [] }; };
export function ticketKeys(pr, keys) {
  const found = [...`${pr.title} ${pr.headRefName}`.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]+-\d+)(?!\d)/g)].map(m => m[1].toUpperCase());
  return [...new Set(found)].filter(k => !keys.length || keys.includes(k.split("-")[0]));
}
export const prColor = p => p.merged || p.state === "MERGED" ? PURPLE : p.state === "CLOSED" ? RED : p.isDraft ? GREY : GREEN;
// PRs (any state) in the watched repos' owners whose title, branch or body names this key.
export async function prsForKey(key) {
  const owners = [...new Set((watched() || await localRepos()).map(r => r.split("/")[0]))];
  const q = `"${key}" is:pr ${owners.map(o => `user:${o}`).join(" ")}`;
  const d = await gql(`query($q:String!){search(query:$q,type:ISSUE,first:20){nodes{... on PullRequest{number title body headRefName state isDraft merged repository{nameWithOwner}}}}}`, { q });
  const re = new RegExp(`(^|[^A-Za-z0-9])${key}(?!\\d)`, "i");
  return d.search.nodes.filter(n => n.number && (re.test(n.title) || re.test(n.headRefName) || re.test(n.body || "")));
}
const chip = s => div().px(5).rounded(4).text_size(10).font_semibold().bg(s.color + "26").text_color(s.color).child(s.label);
function checks(pr) {
  const s = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (!s) return null;
  if (s === "SUCCESS") return { label: "checks passing", glyph: "✓", color: GREEN };
  if (s === "FAILURE" || s === "ERROR") return { label: "checks failing", glyph: "✗", color: RED };
  return { label: "checks pending", glyph: "●", color: YELLOW };
}
// The text an agent receives: repo, number, author, title and state, never a bare number.
export function prLine(pr) {
  const c = checks(pr);
  const st = [prState(pr).label.toLowerCase(), c?.label].filter(Boolean).join(", ");
  return `PR ${pr.repository.nameWithOwner}#${pr.number} by ${pr.author?.login || "unknown"}: ${pr.title} (${st}) - ${pr.url}`;
}

const LIST_FIELDS = `number title url isDraft state updatedAt reviewDecision author{login} repository{nameWithOwner}
  headRefName baseRefName additions deletions commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

async function gql(query, vars) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await exec("gh", args, { timeout: 30000 });
  let body = null;
  try { body = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || !body?.data) throw new Error((body?.errors || []).map(e => e.message).join(" ") || (r.stderr || "gh failed").trim());
  return body.data;
}
const ISSUE_FIELDS = `number title url state stateReason updatedAt author{login} repository{nameWithOwner}
  labels(first:6){nodes{name color}} assignees(first:3){nodes{login}} comments{totalCount}`;
async function searchIssues(q) {
  const d = await gql(`query($q:String!){search(query:$q,type:ISSUE,first:60){issueCount nodes{... on Issue{${ISSUE_FIELDS}}}}}`, { q });
  return { total: d.search.issueCount, items: d.search.nodes.filter(n => n.number) };
}
// An issue's state: open, or closed as done / not planned.
function issueState(i) {
  if (i.state === "OPEN") return { label: "Open", color: GREEN };
  return i.stateReason === "NOT_PLANNED" ? { label: "Not planned", color: GREY } : { label: "Closed", color: PURPLE };
}
export function issueLine(i) {
  const labels = (i.labels?.nodes || []).map(l => l.name).join(", ");
  return `Issue ${i.repository.nameWithOwner}#${i.number} by ${i.author?.login || "unknown"}: ${i.title} (${issueState(i).label.toLowerCase()}${labels ? `; labels: ${labels}` : ""}) - ${i.url}`;
}
async function searchPRs(q) {
  const d = await gql(`query($q:String!){search(query:$q,type:ISSUE,first:60){issueCount nodes{... on PullRequest{${LIST_FIELDS}}}}}`, { q });
  return { total: d.search.issueCount, prs: d.search.nodes.filter(n => n.number) };
}

// Repos cloned in ~/.dev, as owner/name: the default watch list and the settings candidates.
export async function localRepos() {
  const root = `${home()}/.dev`;
  let names = [];
  try { names = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name); } catch {}
  const urls = await Promise.all(names.map(n => exec("git", ["-C", `${root}/${n}`, "remote", "get-url", "origin"]).then(r => r.code === 0 ? r.stdout.trim() : "").catch(() => "")));
  const repos = urls.map(u => (u.match(/github\.com[:/]([^/]+\/[^/.\s]+?)(\.git)?$/) || [])[1]).filter(Boolean);
  return [...new Set(repos)].sort();
}
export const watched = () => shared("github.watch");
// Which integrations show in the toolbar (shared "integrations"); both on until changed in Settings.
// A tab row's order (shared "<key>", e.g. "jira.tabs.order"): saved names first, then any new ones. The first is the default view.
export const tabOrder = (key, names) => {
  const saved = shared(key), keep = Array.isArray(saved) ? saved.filter((n, i) => names.includes(n) && saved.indexOf(n) === i) : [];
  return [...keep, ...names.filter(n => !keep.includes(n))];
};
const GH_VIEWS = ["mine", "watched"], GH_KINDS = ["pr", "issue"];
// How many tickets the Jira list fetches at most (shared "jira.max"): 50 until changed in Settings, 1 to 500.
export const JIRA_MAX_CAP = 500;
export const clampMax = n => Math.min(JIRA_MAX_CAP, Math.max(1, Math.round(Number(n)) || 50));
export const jiraMax = () => clampMax(shared("jira.max") ?? 50);
export const enabled = name => ((shared("integrations") || {})[name] ?? true) !== false;

export function installGithub(P) {
  P.ghInit = function (cx) {
    this.ghView = tabOrder("gh.tabs.order", GH_VIEWS)[0]; this.ghKind = tabOrder("gh.kinds.order", GH_KINDS)[0]; this.ghIssues = []; this.prs = []; this.ghError = null; this.ghLoading = false; this.ghQuery = "";
    this.ghInput = InputState.new({ placeholder: "repo, repo#123, or text…" });
    this.ghInput.on("submit", (_e, cx) => { this.ghQuery = this.ghInput.value().trim(); this.ghRun(cx); });
    this.ghInput.on("change", (_e, cx) => {
      const v = this.ghInput.value().trim(); this.ghHasText = !!v;
      if (!v && this.ghQuery) { this.ghQuery = ""; this.ghLoad(cx); }
      cx.notify();
    });
    if (checking()) return;
    cx.spawn(async cx => { this.ghCandidates = await localRepos(); this.ghLoad(cx); });
    cx.timer.every(180000, cx => { if (this.tool === "github") this.ghLoad(cx); });
  };

  P.ghRepos = function () { return watched() || this.ghCandidates || []; };

  // repo#123 / #123 opens a PR; a repo name lists its PRs; anything else is a text search.
  P.ghRun = function (cx) {
    const q = this.ghQuery, all = [...new Set([...(this.ghCandidates || []), ...this.ghRepos()])];
    const resolve = name => name.includes("/") ? name : all.find(r => r.split("/")[1].toLowerCase() === name.toLowerCase());
    const m = q.match(/^([\w.-]+(?:\/[\w.-]+)?)?#(\d+)$/);
    if (m) {
      const repo = m[1] ? resolve(m[1]) : this.ghRepos().length === 1 ? this.ghRepos()[0] : null;
      if (repo) { this.ghKind === "issue" ? openUrl(`https://github.com/${repo}/issues/${m[2]}`) : this.openPR(repo, Number(m[2])); return; }
    }
    this.ghLoad(cx);
  };

  P.ghSearch = function () {
    return this.ghSearchPR().replace(/^is:pr\b/, this.ghKind === "issue" ? "is:issue" : "is:pr");
  };
  P.ghSearchPR = function () {
    const q = this.ghQuery, repos = this.ghRepos();
    const all = [...new Set([...(this.ghCandidates || []), ...repos])];
    const scope = repos.map(r => `repo:${r}`).join(" ");
    if (q) {
      const repo = q.includes("/") && !q.includes(" ") ? q : all.find(r => r.split("/")[1].toLowerCase() === q.toLowerCase());
      if (repo) { this.ghRepo = repo; return `is:pr is:open repo:${repo} -author:app/dependabot sort:updated-desc`; }
      this.ghRepo = null;
      return `is:pr ${q} ${scope} sort:updated-desc`;
    }
    this.ghRepo = null;
    return this.ghView === "mine"
      ? "is:pr is:open involves:@me sort:updated-desc"
      : `is:pr is:open -author:app/dependabot ${scope} sort:updated-desc`;
  };

  P.ghLoad = function (cx) {
    if (!enabled("github")) return;
    cx.spawn(async cx => {
      this.ghLoading = true; cx.notify();
      try {
        if (this.ghView === "watched" && !this.ghQuery && !this.ghRepos().length) { this.prs = []; this.ghError = "no-repos"; return; }
        if (this.ghKind === "issue") {
          const r = await searchIssues(this.ghSearch());
          this.ghIssues = r.items; this.ghTotal = r.total;
        } else {
          const r = await searchPRs(this.ghSearch());
          this.prs = r.prs; this.ghTotal = r.total;
        }
        this.ghError = null; this.ghAt = new Date();
      } catch (e) {
        if (this.ghKind === "issue") this.ghIssues = []; else this.prs = [];
        this.ghError = String(e?.message || e);
      } finally {
        this.ghLoading = false; cx.notify();
      }
    });
  };

  P.openPR = function (repo, number) {
    openOverlay({ mod: "work", props: { pr: { repo, number } }, kind: "dialog", width: 1000, height: 760 });
  };
  P.openGhSettings = function () {
    openOverlay({ mod: "work", props: { ghSettings: true }, kind: "dialog", width: 480, height: 640 });
  };
  P.sendPR = function (pr) {
    this.openSendItem({ key: `${pr.repository.nameWithOwner.split("/")[1]}#${pr.number}`, summary: pr.title, icon: GH_ICON, tint: true, line: prLine(pr) });
  };

  P.sendGhIssue = function (i) {
    this.openSendItem({ key: `${i.repository.nameWithOwner.split("/")[1]}#${i.number}`, summary: i.title, icon: GH_ICON, tint: true, line: issueLine(i) });
  };

  P.issueRow = function (i) {
    const t = theme(), st = issueState(i), repo = i.repository.nameWithOwner.split("/")[1], id = `${i.repository.nameWithOwner}-${i.number}`;
    const labels = i.labels?.nodes || [], who = (i.assignees?.nodes || []).map(a => a.login);
    return h_flex().id(`is-${id}`).items_stretch().rounded(6)
      .hover(s => s.bg(t.hover)).on_click(() => openUrl(i.url))
      .child(div().w(3).my(6).flex_none().rounded(2).bg(st.color))
      .child(v_flex().flex_1().min_w(0).pl(9).pr(8).py(7).gap(3)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().w(9).h(9).flex_none().rounded(5).border(2).border_color(st.color))
          .child(div().text_color(t.muted).truncate().child(repo))
          .child(div().text_color(t.accent).font_semibold().child(`#${i.number}`))
          .child(div().flex_1())
          .child(div().text_color(t.dim).text_size(10.5).child(ago(i.updatedAt)))
          .when(i.state !== "OPEN", el => el.child(chip(st)))
          .when((i.comments?.totalCount || 0) > 0, el => el.child(div().text_color(t.dim).text_size(10.5).child(`💬 ${i.comments.totalCount}`)))
          .child(div().id(`issend-${id}`).w(22).h(20).flex().items_center().justify_center().rounded(4).text_size(12)
            .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.accent))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.sendGhIssue(i); })
            .child("➤")))
        .child(div().text_size(12.5).line_height(1.35).text_color(t.foreground).child(i.title))
        .child(h_flex().gap(6).items_center().pt(1).flex_wrap()
          .child(avatar(i.author?.login, 16))
          .child(div().text_size(10.5).text_color(t.muted).child(i.author?.login || ""))
          .when(who.length > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child(`→ ${who.join(", ")}`)))
          .children(labels.map(l => div().px(6).rounded(4).bg(`#${l.color}33`).text_color(`#${l.color}`).text_size(10).child(l.name)))));
  };

  P.prRow = function (pr) {
    const t = theme(), st = prState(pr), c = checks(pr), repo = pr.repository.nameWithOwner.split("/")[1];
    return h_flex().id(`pr-${pr.repository.nameWithOwner}-${pr.number}`).items_stretch().rounded(6)
      .hover(s => s.bg(t.hover)).on_click(() => this.openPR(pr.repository.nameWithOwner, pr.number))
      .child(div().w(3).my(6).flex_none().rounded(2).bg(st.color))
      .child(v_flex().flex_1().min_w(0).pl(9).pr(8).py(7).gap(3)
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(svg(GH_ICON).w(13).h(13).flex_none().text_color(t.muted))
          .child(div().text_color(t.muted).truncate().child(repo))
          .child(div().id(`prn-${pr.repository.nameWithOwner}-${pr.number}`).text_color(t.accent).font_semibold().hover(s => s.underline())
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); openUrl(pr.url); })
            .child(`#${pr.number}`))
          .child(div().flex_1())
          .child(div().text_color(t.dim).text_size(10.5).child(ago(pr.updatedAt)))
          .when(!!c, el => el.child(div().text_size(11).font_semibold().text_color(c.color).child(c.glyph)))
          .when(!!openState(pr), el => el.child(chip(openState(pr))))
          .when(!pr.isDraft || pr.state !== "OPEN", el => el.child(chip(st)))
          .child(div().id(`prsend-${pr.repository.nameWithOwner}-${pr.number}`).w(22).h(20).flex().items_center().justify_center().rounded(4).text_size(12)
            .text_color(t.dim).hover(s => s.bg(t.raised).text_color(t.accent))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.sendPR(pr); })
            .child("➤")))
        .child(div().text_size(12.5).line_height(1.35).text_color(t.foreground).child(pr.title))
        .child(h_flex().gap(6).items_center().pt(1)
          .child(avatar(pr.author?.login, 16))
          .child(div().text_size(10.5).text_color(t.muted).child(pr.author?.login || ""))
          .child(div().flex_1().min_w(0).text_size(10.5).text_color(t.dim).truncate().child(`${pr.headRefName} → ${pr.baseRefName}`))));
  };

  P.ghBody = function () {
    const t = theme();
    if (this.ghError === "no-repos") {
      return v_flex().p(14).gap(10).text_size(12).text_color(t.muted)
        .child(div().child("No watched repos yet."))
        .child(this.action("gh-pick", "Choose repos to watch", () => this.openGhSettings(), true));
    }
    if (this.ghError) return div().p(12).text_size(12).text_color(t.blocked).child(this.ghError);
    const issues = this.ghKind === "issue", items = issues ? this.ghIssues : this.prs, row = p => issues ? this.issueRow(p) : this.prRow(p);
    if (!items.length) return div().p(12).text_size(12).text_color(t.dim).child(this.ghLoading ? "Loading…" : issues ? "No open issues." : "No open pull requests.");
    if (this.ghView === "mine" || this.ghQuery) return v_flex().px(4).pt(4).gap(2).children(items.map(row));
    const by = new Map();
    for (const p of items) { const r = p.repository.nameWithOwner; (by.get(r) ?? by.set(r, []).get(r)).push(p); }
    return v_flex().px(4).pb(8).children([...by.entries()].map(([repo, prs]) => {
      const shut = this.folded(`gh:${repo}`);
      return v_flex().pb(6)
        .child(h_flex().id(`ghg-${repo}`).px(8).py(6).gap(7).items_center().rounded(6).border_b(1).border_color(t.border)
          .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.fold(`gh:${repo}`, cx))
          .child(div().w(10).text_size(10).text_color(t.dim).child(shut ? "▸" : "▾"))
          .child(div().text_size(11.5).font_semibold().child(repo.split("/")[1]))
          .child(div().text_size(10.5).text_color(t.dim).child(repo.split("/")[0]))
          .child(div().flex_1())
          .child(div().id(`gho-${repo}`).text_size(10.5).text_color(t.dim).hover(s => s.text_color(t.accent))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); openUrl(`https://github.com/${repo}/${issues ? "issues" : "pulls"}`); }).child("↗"))
          .child(div().px(7).rounded(8).bg(t.raised).text_size(10.5).font_semibold().text_color(t.muted).child(String(prs.length))))
        .when(!shut, el => el.child(v_flex().pt(4).gap(2).children(prs.map(row))));
    }));
  };

  P.renderGithub = function () {
    const t = theme();
    const at = this.ghAt ? `${this.ghAt.getHours()}:${String(this.ghAt.getMinutes()).padStart(2, "0")}` : "";
    return v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(10).h(40).flex_none().gap(4).items_center().border_b(1).border_color(t.border)
        .child(svg(GH_ICON).w(16).h(16).flex_none().text_color(t.foreground))
        .child(div().pl(2).font_semibold().text_size(13).child("GitHub"))
        .child(div().w(6))
        .children(this.tabRow("gh.tabs.order", { mine: "Mine", watched: "Watched" }, name => !this.ghQuery && this.ghView === name,
          (name, cx) => { this.ghView = name; this.ghLoad(cx); }))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(this.ghLoading ? "…" : at))
        .child(this.icon("gh-refresh", "↻", cx => this.ghLoad(cx), { size: 17 })))
      .child(h_flex().px(10).pt(6).flex_none().gap(4).items_center()
        .children(this.tabRow("gh.kinds.order", { pr: "Pull requests", issue: "Issues" }, name => this.ghKind === name,
          (name, cx) => { this.ghKind = name; this.ghLoad(cx); })))
      .child(h_flex().px(10).py(6).flex_none().child(
        h_flex().flex_1().h(28).px(8).rounded(6).border(1).border_color(t.input).bg(t.background).items_center()
          .child(Input.new(this.ghInput).flex_1().h_full().text_size(12).text_color(t.foreground))
          .when(!!this.ghHasText || !!this.ghQuery, el => el.child(div().id("gh-clear").w(20).h(20).flex_none().flex().items_center().justify_center()
            .rounded(10).text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.ghInput.set_value(""); this.ghHasText = false; if (this.ghQuery) { this.ghQuery = ""; this.ghLoad(cx); } else cx.notify(); })
            .child("✕")))))
      .when(!!this.ghRepo, el => el.child(h_flex().id("gh-repo").mx(10).mb(6).px(10).py(6).gap(8).items_center().rounded(6).bg(t.surface)
        .border(1).border_color(t.border).hover(s => s.bg(t.hover)).on_click(() => openUrl(`https://github.com/${this.ghRepo}`))
        .child(svg(GH_ICON).w(14).h(14).text_color(t.foreground))
        .child(div().flex_1().text_size(12).font_semibold().child(this.ghRepo))
        .child(div().text_size(11).text_color(t.accent).child("Open repo ↗"))))
      .child(div().flex_1().id("gh-list").overflow_y_scrollbar().child(this.ghBody()));
  };

  // ---- PR details dialog (an overlay copy with props.pr) ----
  P.loadPR = function (cx) {
    const { repo, number } = this.prRef, [owner, name] = repo.split("/");
    cx.spawn(async cx => {
      try {
        const d = await gql(`query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){
          ${LIST_FIELDS} merged bodyHTML createdAt changedFiles comments{totalCount}
          labels(first:10){nodes{name color}}
          reviewRequests(first:10){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
          latestReviews(first:10){nodes{author{login} state submittedAt}}
          checkCommit: commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:40){nodes{
            ... on CheckRun{name conclusion status detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}}}}`,
          { o: owner, n: name, num: number });
        this.pr = d.repository.pullRequest;
        if (!this.pr) this.prError = `No PR ${repo}#${number}.`;
        else { this.prCache?.set(`${repo}#${number}`, this.pr); this.linkPR?.(this.pr, cx); }
      } catch (e) {
        this.prError = String(e?.message || e);
      } finally {
        cx.notify();
      }
    });
  };

  P.renderPR = function () {
    const t = theme(), pr = this.pr, { repo, number } = this.prRef;
    const url = pr?.url || `https://github.com/${repo}/pull/${number}`;
    const head = h_flex().px(18).h(48).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(GH_ICON).w(16).h(16).flex_none().text_color(t.foreground))
      .child(div().text_size(12).text_color(t.muted).child(repo))
      .child(div().id("pr-num").text_size(12.5).font_semibold().text_color(t.accent).hover(s => s.underline()).on_click(() => openUrl(url)).child(`#${number}`))
      .child(div().flex_1())
      .when(!!pr, el => el.child(this.action("pr-send", "➤ Send to agent", () => this.sendPR(pr), true)))
      .child(this.action("pr-open", "Open in GitHub ↗", () => openUrl(url), false))
      .child(this.icon("pr-close", "✕", () => closeOverlay(this.overlay), { size: 14 }));
    if (!pr) {
      return v_flex().size_full().bg(t.popover).text_color(t.foreground).child(head).child(this.linkBar())
        .child(div().p(18).text_size(12.5).text_color(this.prError ? t.blocked : t.dim).child(this.prError || "Loading…"));
    }
    const st = prState(pr), fmt = iso => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
    const roll = pr.checkCommit?.nodes?.[0]?.commit?.statusCheckRollup;
    const ctx = (roll?.contexts?.nodes || []).map(n => n.name
      ? { name: n.name, ok: n.conclusion, url: n.detailsUrl, pending: n.status !== "COMPLETED" }
      : { name: n.context, ok: n.state, url: n.targetUrl, pending: n.state === "PENDING" });
    const ckColor = c => c.pending ? YELLOW : /SUCCESS|NEUTRAL|SKIPPED/.test(c.ok || "") ? GREEN : RED;
    const label = text => div().pb(5).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const field = (k, v) => v_flex().pb(14).child(label(k)).child(typeof v === "string" ? div().text_size(12.5).child(v) : v);
    const person = login => h_flex().gap(8).items_center().child(avatar(login, 22)).child(div().text_size(12.5).child(login || "—"));
    const reviewColor = s => s === "APPROVED" ? GREEN : s === "CHANGES_REQUESTED" ? RED : GREY;
    const side = v_flex().w(250).flex_none().p(18).border_l(1).border_color(t.border).bg(t.surface)
      .child(field("Status", h_flex().gap(6).items_center().when(!!openState(pr) && !pr.isDraft, el => el.child(chip(openState(pr)))).child(h_flex().gap(6).items_center().px(10).py(4).rounded(6).bg(t.raised)
        .child(div().w(8).h(8).rounded(4).bg(st.color)).child(div().text_size(12).font_semibold().child(st.label)))))
      .child(field("Author", person(pr.author?.login)))
      .child(field("Branch", v_flex().gap(2).child(div().text_size(12).child(pr.headRefName)).child(div().text_size(11).text_color(t.dim).child(`into ${pr.baseRefName}`))))
      .child(field("Changes", h_flex().gap(8).text_size(12.5)
        .child(div().text_color(GREEN).child(`+${pr.additions}`)).child(div().text_color(RED).child(`−${pr.deletions}`))
        .child(div().text_color(t.dim).child(`${pr.changedFiles} files`))))
      .when((pr.latestReviews?.nodes || []).length > 0, el => el.child(field("Reviews", v_flex().gap(6).children(pr.latestReviews.nodes.map(r =>
        h_flex().gap(8).items_center().child(avatar(r.author?.login, 18)).child(div().flex_1().text_size(12).child(r.author?.login || ""))
          .child(div().text_size(10.5).font_semibold().text_color(reviewColor(r.state)).child(r.state.replace(/_/g, " ").toLowerCase())))))))
      .when((pr.reviewRequests?.nodes || []).length > 0, el => el.child(field("Requested", (pr.reviewRequests.nodes.map(n => n.requestedReviewer?.login || n.requestedReviewer?.name).filter(Boolean).join(", ")) || "—")))
      .when((pr.labels?.nodes || []).length > 0, el => el.child(field("Labels", h_flex().flex_wrap().gap(4).children(pr.labels.nodes.map(l =>
        div().px(7).py(1).rounded(4).bg(`#${l.color}33`).text_color(`#${l.color}`).text_size(11).child(l.name))))))
      .child(div().h(1).my(6).bg(t.border))
      .child(field("Created", fmt(pr.createdAt)))
      .child(field("Updated", `${fmt(pr.updatedAt)} · ${ago(pr.updatedAt)} ago`));
    const heading = text => div().pt(22).pb(10).text_size(13).font_semibold().child(text);
    const main = v_flex().id("pr-main").flex_1().min_w(0).overflow_y_scrollbar().px(24).pb(24)
      .child(div().pt(18).text_size(19).font_semibold().line_height(1.3).child(pr.title))
      .child(heading("Description"))
      .child(pr.bodyHTML ? TextView.html("pr-body", pr.bodyHTML).text_size(13).selectable(true).on_link_click(u => openUrl(u))
        : div().text_size(12.5).text_color(t.dim).child("No description."))
      .child(heading(`Checks · ${ctx.length}`))
      .children(ctx.length ? ctx.map((c, i) => h_flex().id(`ck-${i}`).px(10).py(6).gap(8).items_center().rounded(6)
        .hover(s => s.bg(t.hover)).on_click(() => c.url && openUrl(c.url))
        .child(div().w(8).h(8).flex_none().rounded(4).bg(ckColor(c)))
        .child(div().flex_1().text_size(12.5).truncate().child(c.name))
        .child(div().text_size(11).text_color(t.dim).child(c.pending ? "pending" : (c.ok || "").toLowerCase())))
        : [div().text_size(12.5).text_color(t.dim).child("No checks reported.")])
      .child(div().pt(18).text_size(11.5).text_color(t.dim).child(`${pr.comments?.totalCount ?? 0} comments on GitHub`));
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).child(head).child(this.linkBar())
      .child(h_flex().flex_1().min_h(0).items_stretch().child(main).child(side));
  };

  // ---- watched repos dialog (an overlay copy with props.ghSettings) ----
  P.ghSettingsInit = function (cx) {
    this.stTab = "integrations";
    this.intOn = { jira: enabled("jira"), github: enabled("github") };
    this.defAgent = (shared("jira.send") || {}).agent || "";
    this.agentList = terminals().filter(k => k.state === "live" && k.labels?.["peerlink.agent"]).map(k => k.labels["peerlink.agent"]).sort();
    this.watchSel = new Set(watched() || []);
    this.watchSet = !!watched();
    this.linkSet = linkCfg();
    this.keysInput = InputState.new({ placeholder: "ABC, XYZ (empty = any project)" });
    this.keysInput.set_value(this.linkSet.keys.join(", "));
    this.maxInput = InputState.new({ placeholder: "50" });
    this.maxInput.set_value(String(jiraMax()));
    this.addInput = InputState.new({ placeholder: "owner/repo" });
    this.addInput.on("submit", (_e, cx) => this.addRepo(cx));
    if (checking()) return;
    cx.spawn(async cx => {
      this.cands = await localRepos();
      if (!this.watchSet) this.watchSel = new Set(this.cands);
      cx.notify();
    });
  };
  P.addRepo = function (cx) {
    const v = this.addInput.value().trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(v)) { this.watchSel.add(v); this.extra = [...new Set([...(this.extra || []), v])]; this.addInput.set_value(""); }
    cx.notify();
  };
  P.renderGhSettings = function () {
    const t = theme();
    const toggle = (id, on, flip) => div().id(id).w(36).h(20).flex_none().rounded(10).p(2)
      .bg(on ? t.accent : t.input).on_click((_e, cx) => { flip(); cx.notify(); })
      .child(div().w(16).h(16).rounded(8).bg("#ffffff").when(on, el => el.ml(16)));
    const tabs = [["integrations", "Integrations", null], ["jira", "Jira", image("mods/work/icons/jira.svg").w(14).h(14)],
      ["github", "GitHub", svg(GH_ICON).w(14).h(14).text_color(t.foreground)], ["linking", "Linking", null], ["agents", "Agents", null]];
    const tabBar = h_flex().px(14).pt(8).flex_none().gap(2).border_b(1).border_color(t.border)
      .children(tabs.map(([k, label, icon]) => {
        const on = this.stTab === k;
        return h_flex().id(`st-${k}`).px(10).pb(7).gap(6).items_center().border_b(2).border_color(on ? t.accent : "#00000000")
          .on_click((_e, cx) => { this.stTab = k; cx.notify(); })
          .when(!!icon, el => el.child(icon))
          .child(div().text_size(12.5).font_semibold().text_color(on ? t.foreground : t.muted).child(label));
      }));
    const heading = text => div().px(4).pb(8).text_size(11).font_semibold().text_color(t.dim).child(text);
    const note = text => div().px(4).pb(10).text_size(11.5).text_color(t.muted).child(text);
    let body;
    if (this.stTab === "integrations") {
      const item = (k, name, icon, about) => h_flex().px(10).py(10).gap(10).items_center().rounded(8).border(1).border_color(t.border).mb(8)
        .child(icon).child(v_flex().flex_1().gap(2).child(div().text_size(12.5).font_semibold().child(name))
          .child(div().text_size(11).text_color(t.dim).child(about)))
        .child(toggle(`tg-${k}`, this.intOn[k], () => { this.intOn[k] = !this.intOn[k]; }));
      body = v_flex()
        .child(heading("INTEGRATIONS"))
        .child(note("Turned-off integrations leave the toolbar and stop refreshing."))
        .child(item("jira", "Jira", image("mods/work/icons/jira.svg").w(20).h(20), "Your issues and the sprint, via Atlassian sign-in"))
        .child(item("github", "GitHub", svg(GH_ICON).w(20).h(20).text_color(t.foreground), "Open PRs in watched repos, via your gh login"));
    } else if (this.stTab === "jira") {
      body = v_flex()
        .child(heading("MAX JIRA TICKETS"))
        .child(note(`How many tickets a list shows at most, from 1 to ${JIRA_MAX_CAP}. More tickets take longer to load. Applies from the next refresh.`))
        .child(h_flex().w(90).h(30).px(8).mb(16).rounded(6).border(1).border_color(t.input).bg(t.background).items_center()
          .child(Input.new(this.maxInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
        .child(heading("ACCOUNT"))
        .child(note("Signed in with Atlassian OAuth. Signing out deletes the saved login; the panel then offers Log in again."))
        .child(h_flex().px(4).gap(8)
          .child(this.action("st-signout", this.signedOut ? "Signed out" : "Sign out", cx => {
            exec(window().platform === "windows" ? "python" : "python3", [`${home()}/.herdr-jira/oauth.py`, "logout"]); this.signedOut = true; cx.notify();
          }, false)));
    } else if (this.stTab === "linking") {
      body = v_flex()
        .child(heading("JIRA ↔ GITHUB"))
        .child(h_flex().px(10).py(10).gap(10).items_center().rounded(8).border(1).border_color(t.border).mb(14)
          .child(v_flex().flex_1().gap(2).child(div().text_size(12.5).font_semibold().child("Link tickets and PRs"))
            .child(div().text_size(11).text_color(t.dim).child("Ticket and PR dialogs get a bar to switch between them")))
          .child(toggle("tg-link", this.linkSet.on, () => { this.linkSet.on = !this.linkSet.on; })))
        .child(heading("JIRA PROJECTS"))
        .child(note("A PR links to a ticket when its title or branch names a key from these projects, e.g. ABC-123. A ticket links to every PR in the watched repos' orgs that names it."))
        .child(h_flex().h(30).px(8).rounded(6).border(1).border_color(t.input).bg(t.background).items_center()
          .child(Input.new(this.keysInput).flex_1().h_full().text_size(12).text_color(t.foreground)));
    } else if (this.stTab === "agents") {
      const agents = (this.agentList ||= []);
      body = v_flex()
        .child(heading("DEFAULT AGENT"))
        .child(note("Where Send to agent points first. You can still pick another agent in the send window."))
        .children([...new Set([this.defAgent, ...agents].filter(Boolean))].map(n => {
          const on = n === this.defAgent;
          return h_flex().id(`da-${n}`).px(10).py(7).mb(4).gap(10).items_center().rounded(7).border(1)
            .border_color(on ? t.accent : t.border).when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { this.defAgent = n; cx.notify(); })
            .child(avatar(n, 22)).child(div().flex_1().text_size(12.5).child(n))
            .child(div().text_size(12).text_color(t.accent).child(on ? "✓" : ""));
        }));
    } else {
      const list = [...new Set([...(this.cands || []), ...(this.extra || []), ...this.watchSel])].sort();
      const row = repo => {
        const on = this.watchSel.has(repo);
        return h_flex().id(`w-${repo}`).px(8).py(5).gap(8).items_center().rounded(5).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { on ? this.watchSel.delete(repo) : this.watchSel.add(repo); cx.notify(); })
          .child(div().w(14).h(14).flex_none().rounded(3).border(1).border_color(on ? t.accent : t.input)
            .when(on, el => el.bg(t.accent)).flex().items_center().justify_center()
            .text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
          .child(div().flex_1().text_size(12.5).child(repo.split("/")[1]))
          .child(div().text_size(11).text_color(t.dim).child(repo.split("/")[0]));
      };
      body = v_flex()
        .child(h_flex().px(4).pb(8).gap(12).text_size(11.5)
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(`WATCHED REPOS · ${this.watchSel.size}`))
          .child(div().id("w-all").text_color(t.accent).on_click((_e, cx) => { list.forEach(r => this.watchSel.add(r)); cx.notify(); }).child("All"))
          .child(div().id("w-none").text_color(t.accent).on_click((_e, cx) => { this.watchSel.clear(); cx.notify(); }).child("None")))
        .children(this.cands ? list.map(row) : [div().p(8).text_size(12).text_color(t.dim).child("Finding repos…")])
        .child(h_flex().pt(10).gap(8).items_center()
          .child(h_flex().flex_1().h(30).px(8).rounded(6).border(1).border_color(t.input).bg(t.background).items_center()
            .child(Input.new(this.addInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
          .child(this.action("w-add", "Add", cx => this.addRepo(cx), false)));
    }
    const saveAll = () => {
      setShared("integrations", { ...this.intOn });
      setShared("link", { on: this.linkSet.on, keys: this.keysInput.value().split(/[\s,]+/).map(k => k.trim().toUpperCase()).filter(Boolean) });
      setShared("github.watch", [...this.watchSel].sort());
      setShared("jira.send", { ...(shared("jira.send") || {}), agent: this.defAgent });
      setShared("jira.max", clampMax(this.maxInput.value().trim() || 50));
      closeOverlay(this.overlay);
    };
    return v_flex().size_full().bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(18).h(48).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13.5).font_semibold().child("Settings"))
        .child(div().flex_1())
        .child(this.icon("w-close", "✕", () => closeOverlay(this.overlay), { size: 14 })))
      .child(tabBar)
      .child(v_flex().id("st-body").flex_1().overflow_y_scrollbar().px(14).py(12).child(body))
      .child(h_flex().px(18).h(54).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1())
        .child(this.action("w-cancel", "Cancel", () => closeOverlay(this.overlay), false))
        .child(this.action("w-save", "Save", saveAll, true)));
  };

}
