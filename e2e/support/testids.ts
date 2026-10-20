// The registry of every test id the suite uses (REFACTORING.md section
// 11, D24). Tests import from here and never write a literal id; the app
// side adopts these ids in the testids deliverable, enforced by
// src/test/testids.test.ts.
//
// data-testid is the primary locator; Playwright's default test-id
// attribute is already data-testid, so no configuration is needed.
export const testids = {
	/** The "cannot reach the server" screen of the sign-in gate. */
	gateUnreachable: "gate-unreachable",
	/** The sign-in form itself (server reachable, no live session). */
	signinForm: "signin-form",
	/** Server address field on the sign-in form. */
	authUrl: "auth-url",
	/** Handle field on the sign-in form. */
	authHandle: "auth-handle",
	/** Password field on the sign-in form. */
	authPassword: "auth-password",
	/** The application shell once the gate is open. */
	shellApp: "shell-app",
	/** The sync-state chip in the shell (one wrapper, badge inside varies). */
	syncChip: "sync-chip",
	/** Banner over the content while open but offline. */
	offlineBanner: "offline-banner",
	/** Banner on Templates when rows are conflicted. */
	conflictBanner: "conflict-banner",
	/** The three-way conflict dialog. */
	conflictDialog: "conflict-dialog",
	/** Conflict dialog: keep pushing the local edits. */
	conflictKeepMine: "conflict-keep-mine",
	/** Conflict dialog: discard local edits for the server copy. */
	conflictTakeServer: "conflict-take-server",
	/** Conflict dialog: duplicate locally, then take the server copy. */
	conflictKeepBoth: "conflict-keep-both",
	/** File import control in the designer toolbar. */
	templateImport: "template-import",
	/** Tailwind warnings panel in the designer. */
	classWarnings: "class-warnings",
} as const;

export type TestId = (typeof testids)[keyof typeof testids];
