# PrintNinja: Online-Only Server Migration Plan

Branch: `v2` · Status: Phase 1 implemented, phase 2 checked by reading · Date: 2026-10-19

Minimum scope: the server stores a copy of each user's templates and owns sign-in. Editing and printing keep working on the local copy exactly as they do today. Save pushes the template to the server, and a Refresh button pulls it back on another PC. Printing never contacts the server, and almost everything reuses columns, screens and server routes that already exist.

## 1. Scope

| Area | After |
| --- | --- |
| Auth | Required sign-in on the existing server routes. Token stays in the `settings` table as today |
| Templates (server) | A stored copy of the current version: name, html, css, page size, readme. Private when `published_at` is empty, public when set |
| Templates (local) | The existing local `templates` row, linked to the server by the existing `remote_id`. This is where editing happens, as today. Only Mine and Saved templates are synced |
| Save and Refresh | Save pushes the current local version to the server. Refresh pulls the server version over the local one, after a confirmation |
| Community and saved templates | Server, unchanged. Read-only for everyone except the author, including the local copy |
| Existing local templates | Uploaded with Save. No export or import |
| Version history, sample datasets | Local, as today. Not synced |
| Printers, profiles, presets, fonts | Local, unchanged |
| Print pipeline, queue, transports, history, batches | Local, unchanged. Reads the local copy only |
| Local REST API, deep links | Local, unchanged. Look up the local copy only |

The server already has register, login, logout, `me`, throttling, template PUT/GET/DELETE, saved templates and use counts (`server-legacy/src/main.rs`, 9 routes under `/v1`). The client already calls it with `fetch` from `src/lib/share/client.ts`. The local `templates` table already has `remote_id`, `origin`, `origin_owner`, `published_at` and `withdrawn`.

## 2. Decisions

All decided except the last item below.

| Topic | Decision |
| --- | --- |
| Where editing happens | On the local copy, as today. Save pushes to the server; Refresh pulls from it. The user's own save needs no extra update step, because the local copy is already the edited version |
| Printing | Uses the local copy. No server call at print time |
| Which templates are synced | Mine and Saved only. Saved (community) templates are read-only: no editing, no Save, no Publish. The server rejects edits from non-owners |
| Server unreachable at start | The app shows a "cannot reach server" screen and stays blocked. If the server goes down while the app is open, printing keeps working |
| Refresh | One button per template. It asks for confirmation, because it overwrites unsaved local edits |
| Existing local templates | Uploaded with the Save button, as private templates. No export or import |
| Template ids | Keep local integer ids and link to the server through `remote_id`. Jobs, batches and history are untouched |
| Visibility | `published_at` empty means private; set means published. No new column |
| Orientation | Derived from page width and height. Not stored on the server |
| Edit conflicts | The last push wins. No revision numbers |
| Update badge | Not built. Refresh only |
| A template deleted on the server | Refresh shows an error and the local copy stays as it is. No special state |
| Version history and sample datasets | Not synced |
| Fonts | Stay local on each device |
| CSS transport | Add a `css` column on the server so template CSS is stored and returned with the HTML. Save, Refresh and Get from server all carry it, so CSS is no longer lost |
| Local metadata writes | Add an `update_template_meta` local command that writes a template's name, page size and summary. Refresh and Get from server use it, because no existing local command does this (only the readme and new versions) |
| Shared PCs | Local templates stay on the device and are visible to anyone who signs in. The Print page lists every local template on the PC, whoever saved it. Saving someone else's template returns 403 from the server |
| Accounts | Anyone who can reach the server can register, as today. Restrict access at the network level when deploying |

Still open:

1. **Copying a community template to edit it.** Recommendation: not in the first release. Saved templates stay read-only; add a Save a copy to Mine action later if users ask.

## 3. Phases

### Phase 1: Save, Refresh and Get from server

- Add a `css` column to the server's template storage, and return it from the owner GET and the public routes.
- Add an `update_template_meta` local command that updates a template's name, page size and summary.
- Add Save to the Designer and Templates rows. It sends the current local version (html and css) to the server through the existing publish routine in `src/lib/share/client.ts`, as private unless the user publishes, and stores the returned `remote_id`. Extend the routine to send the CSS, since today only the HTML is sent.
- Add a Refresh button per template. After a confirmation, it fetches the template and overwrites the local copy: html and css through the existing local commands, and name, page size and summary through `update_template_meta`. If the fetch fails, show the error and leave the copy as it is.
- Add a Get from server dialog that lists the user's Mine and Saved templates and downloads the chosen ones into the local database with `remote_id` set, including their CSS, name, page size and summary (written through `update_template_meta`). This is how a new PC gets its templates.
- Make Saved (community) templates read-only: hide Edit, Save and Publish on them, using the existing local `origin` value `saved`.
- Done when: a template saved on one PC appears on another through Get from server, an edit shows up there after Refresh, and prints from the local copy.

**Built.** `update_template_meta` and the `sync` version marker were added to `src-tauri`; the `css` column, the client sync module and the three actions live in `server-legacy/src/db.rs`, `src/lib/share/sync.ts` and the Designer and Templates screens. Covered by `src-tauri/tests/template_sync.rs`, `src/test/shareSync.test.ts`, the server route tests and the Templates and Designer page tests. The manual walk-through in section 4 has not been run.

### Phase 2: Check the print path

- Confirm that `print_html`, `api/routes.rs`, `deeplink.rs`, `commands/batch.rs` and reprint read only the local copy and make no network call.
- Done when: every print route works with the network off.

**Done.** `print_html` resolves the template and its current version from SQLite; `api/routes.rs`, `deeplink.rs` and `commands/batch.rs` query SQLite; `reprint_job` replays the `rendered_html` stored on the original job. The only network call in the crate is `data::fetcher`, reached only when a job carries a `data_url` that the person set. `src-tauri/tests/print_path_offline.rs` guards this, and the renderer still refuses templates that pull in remote assets.

Still to do by hand: print something with the network off, to see it with your own eyes.

## 4. Testing

- Server: route tests for auth, private and published visibility, owner checks and caps.
- Client: update `templates.test.tsx` and `designer.test.tsx` to mock the API client; add tests for Save, Refresh with confirmation, Get from server and read-only saved templates.
- Rust: add a test that printing makes no network call.
- Manual: save a template on PC A, load it on PC B with Get from server, edit on A, refresh on B, then print on B with the network off.

## 5. Deferred

Left out to reduce work; each can be added later.

| Item | Why it is safe to defer |
| --- | --- |
| Editing directly on the server | Local editing already works and needs no rewrite of the Designer |
| Export and import files | Save uploads existing templates |
| Print-only mode when the server is down at start | A blocking screen is simpler; revisit if the server is unreliable |
| Server-side version history and sample datasets | Both stay local as today |
| UUID keys across jobs and history | `remote_id` already links the two |
| Revision numbers and conflict rejection | The last push wins is acceptable for an internal tool at first |
| Update badge and last-synced time | The Refresh button does the same job |
| Special handling of templates deleted on the server | Refresh shows an error and the copy stays printable |
| Orientation and visibility columns | Derived from page size and `published_at` |
| Token in the OS keyring | The token stays in the `settings` table as today |
| Hardening and doc updates | Restrict network access when deploying; follow `docs/SECURITY_HARDENING.md` and update the offline wording in `README.md` later |

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Refresh overwrites unsaved local edits | Confirmation before Refresh |
| The last push overwrites an edit made on another PC | Accept for now; add revision numbers if it happens |
| A PC prints an outdated template | Refresh on each template; users refresh before printing after a change elsewhere |
| The server is down when the app starts | The app is blocked until it is back; printing in a running app is unaffected |
| A user on a shared PC pushes a template owned by someone else | The server returns 403 from its owner check |
| Open registration lets anyone create an account | Restrict network access at deployment |
