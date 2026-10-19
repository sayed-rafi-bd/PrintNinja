# PrintNinja: Online-Only Server Migration Plan

Branch: `v2` · Status: Proposed · Date: 2026-10-19

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

The server already has register, login, logout, `me`, throttling, template PUT/GET/DELETE, saved templates and use counts (`server/src/main.rs`, 9 routes under `/v1`). The client already calls it with `fetch` from `src/lib/share/client.ts`. The local `templates` table already has `remote_id`, `origin`, `origin_owner`, `published_at` and `withdrawn`.

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
| Shared PCs | Local templates stay on the device and are visible to anyone who signs in. The Print page lists every local template on the PC, whoever saved it. Saving someone else's template returns 403 from the server |
| Accounts | Anyone who can reach the server can register, as today. Restrict access at the network level when deploying |

Still open:

1. **Copying a community template to edit it.** Recommendation: not in the first release. Saved templates stay read-only; add a Save a copy to Mine action later if users ask.

## 3. Phases

### Phase 1: Server

- Allow private templates: let the existing PUT store a template with `published_at` empty, and make the public list return published rows only.
- Add a list-mine route and a full-template GET for the owner. Reuse the existing owner checks, saved routes and size caps (512K body, 64K readme).
- Done when: server tests cover private versus published visibility, owner-only access, caps and delete.

### Phase 2: Sign-in gate

- Add a login and register screen shown before the app shell when there is no valid session.
- Add a "cannot reach server" screen with a Retry button for when sign-in cannot reach the server at start.
- Return to sign-in on a 401. Unsaved edits are safe because they live in the local copy.
- Done when: the app cannot be used without a session, and printing keeps working if the server drops after sign-in.

### Phase 3: Save, Refresh and Get from server

- Add Save to the Designer and Templates rows. It sends the current local version to the server through the existing publish routine in `src/lib/share/client.ts`, as private unless the user publishes, and stores the returned `remote_id`.
- Add a Refresh button per template. After a confirmation, it fetches the template and overwrites the local copy through the existing local commands. If the fetch fails, show the error and leave the copy as it is.
- Add a Get from server dialog that lists the user's Mine and Saved templates and downloads the chosen ones into the local database with `remote_id` set. This is how a new PC gets its templates.
- Make Saved (community) templates read-only: hide Edit, Save and Publish on them, using the existing local `origin` value `saved`.
- Done when: a template saved on one PC appears on another through Get from server, an edit shows up there after Refresh, and prints from the local copy.

### Phase 4: Check the print path

- Confirm that `print_html`, `api/routes.rs`, `deeplink.rs`, `commands/batch.rs` and reprint read only the local copy and make no network call.
- Done when: every print route works with the network off.

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
