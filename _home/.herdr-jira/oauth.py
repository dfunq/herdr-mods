"""Atlassian OAuth 2.0 (3LO) helper for the herdr Jira panel.

  python oauth.py login   opens the browser, catches the callback on localhost, saves tokens
  python oauth.py token   prints {"access_token", "cloud_id", "site"} as JSON, refreshing when needed
  python oauth.py logout  deletes the saved tokens

app.json (written by you): {"client_id": "...", "client_secret": "...", "site": "your-site.atlassian.net" (optional)}
tokens.json (written here): access/refresh tokens and the chosen site.
"""
import http.server, json, os, secrets, sys, time, urllib.parse, urllib.request, webbrowser

DIR = os.path.dirname(os.path.abspath(__file__))
APP, TOKENS = os.path.join(DIR, "app.json"), os.path.join(DIR, "tokens.json")
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/callback"
SCOPES = "read:jira-work write:jira-work read:jira-user offline_access"


def log(msg):
    try:
        with open(os.path.join(DIR, "login.log"), "a") as f:
            f.write(time.strftime("%H:%M:%S ") + msg + "\n")
    except Exception:
        pass


def fail(msg, code=1):
    log("fail: " + str(msg))
    print(json.dumps({"error": msg}))
    sys.exit(code)


def app():
    try:
        a = json.load(open(APP, encoding="utf-8-sig"))
        if a.get("client_id") and a.get("client_secret") and "paste" not in a["client_id"]:
            return a
    except Exception:
        pass
    fail("no-app")


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def save(tok, extra):
    data = {**extra, "access_token": tok["access_token"],
            "refresh_token": tok.get("refresh_token") or extra.get("refresh_token"),
            "expires_at": time.time() + int(tok.get("expires_in", 3600)) - 60}
    with open(TOKENS, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def login():
    a, state, got = app(), secrets.token_urlsafe(16), {}

    # Only one sign-in at a time: stop an earlier helper still waiting for its callback.
    pidfile = os.path.join(DIR, "login.pid")
    try:
        old = int(open(pidfile).read())
        if old != os.getpid():
            os.kill(old, 9)
            time.sleep(0.5)
    except Exception:
        pass
    open(pidfile, "w").write(str(os.getpid()))

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            log("request " + u.path + " keys=" + ",".join(sorted(urllib.parse.parse_qs(u.query))))
            if u.path != "/callback":
                self.send_response(404); self.end_headers(); return
            q = urllib.parse.parse_qs(u.query)
            ok = q.get("state", [""])[0] == state and "code" in q
            if ok:
                got["code"] = q["code"][0]
            elif "error" in q:
                got["error"] = q.get("error_description", q["error"])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            msg = ("Signed in to Jira. You can close this tab." if ok else
                   f"Jira sign-in failed: {got.get('error') or 'this link is from an older sign-in attempt'}. Close this tab and click Log in again.")
            self.wfile.write(f"<html><body style='font-family:sans-serif;padding:40px'>{msg}</body></html>".encode())

        def log_message(self, *a):
            pass

    class Exclusive(http.server.HTTPServer):
        allow_reuse_address = False

        def server_bind(self):
            import socket
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    class Exclusive6(Exclusive):
        import socket as _s
        address_family = _s.AF_INET6

    try:
        srv = Exclusive(("127.0.0.1", PORT), H)
    except OSError:
        fail(f"Port {PORT} is busy. Close other sign-in attempts and try again.")
    srv.timeout = 1
    # The callback URL says "localhost", which browsers often try as IPv6 (::1) first: listen there too.
    servers = [srv]
    try:
        srv6 = Exclusive6(("::1", PORT), H)
        srv6.timeout = 1
        servers.append(srv6)
    except OSError:
        pass
    log("listening on %d (%s)" % (PORT, "ipv4+ipv6" if len(servers) > 1 else "ipv4"))
    url = "https://auth.atlassian.com/authorize?" + urllib.parse.urlencode({
        "audience": "api.atlassian.com", "client_id": a["client_id"], "scope": SCOPES,
        "redirect_uri": REDIRECT, "state": state, "response_type": "code", "prompt": "consent"})
    # macOS: Python's webbrowser goes through osascript, which silently does nothing when herdr starts us.
    opened = False
    if sys.platform == "darwin":
        import subprocess
        opened = subprocess.run(["/usr/bin/open", url], capture_output=True).returncode == 0
    if not opened:
        webbrowser.open(url)
    log("browser opened=%s" % opened)
    end = time.time() + 280
    import select
    while "code" not in got and "error" not in got and time.time() < end:
        ready, _, _ = select.select(servers, [], [], 1)
        for s in ready:
            s.handle_request()
    for s in servers:
        s.server_close()
    try:
        os.remove(pidfile)
    except Exception:
        pass
    if "code" not in got:
        fail(got.get("error") or "Sign-in timed out or was cancelled.")
    tok = post("https://auth.atlassian.com/oauth/token", {
        "grant_type": "authorization_code", "client_id": a["client_id"], "client_secret": a["client_secret"],
        "code": got["code"], "redirect_uri": REDIRECT})
    req = urllib.request.Request("https://api.atlassian.com/oauth/token/accessible-resources",
                                 headers={"Authorization": f"Bearer {tok['access_token']}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        sites = json.load(r)
    site = next((s for s in sites if a.get("site") and a["site"] in s.get("url", "")), sites[0] if sites else None)
    if not site:
        fail("This login has no Jira site.")
    log("signed in to " + site.get("url", "?"))
    save(tok, {"cloud_id": site["id"], "site": site["url"]})
    print(json.dumps({"ok": True, "site": site["url"]}))


def token():
    app()
    try:
        t = json.load(open(TOKENS, encoding="utf-8"))
    except Exception:
        fail("no-login")
    if time.time() > t.get("expires_at", 0):
        a = app()
        try:
            tok = post("https://auth.atlassian.com/oauth/token", {
                "grant_type": "refresh_token", "client_id": a["client_id"], "client_secret": a["client_secret"],
                "refresh_token": t["refresh_token"]})
        except Exception:
            fail("no-login")
        t = save(tok, t)
    print(json.dumps({"access_token": t["access_token"], "cloud_id": t["cloud_id"], "site": t["site"]}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "token"
    if cmd == "login":
        login()
    elif cmd == "logout":
        if os.path.exists(TOKENS):
            os.remove(TOKENS)
        print(json.dumps({"ok": True}))
    else:
        token()
