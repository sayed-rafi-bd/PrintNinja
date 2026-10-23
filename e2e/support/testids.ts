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
  /** Settings font row id (parameterized in the app). */
  fontRow: (id: number | string) => `font-row-${id}`,
  /** Prefix for "any font row" locators. */
  fontRowPrefix: "font-row-",
  /** The three-way conflict dialog (legacy conflicted rows on Templates). */
  conflictDialog: "conflict-dialog",
  /** Conflict dialog: keep pushing the local edits. */
  conflictKeepMine: "conflict-keep-mine",
  /** Conflict dialog: discard local edits for the server copy. */
  conflictTakeServer: "conflict-take-server",
  /** Conflict dialog: duplicate locally, then take the server copy. */
  conflictKeepBoth: "conflict-keep-both",
  /** Designer save-conflict dialog: the server copy moved since last save. */
  saveConflictDialog: "save-conflict-dialog",
  /** Save-conflict dialog: overwrite the server with the editor's copy. */
  saveConflictOverwrite: "save-conflict-overwrite",
  /** Save-conflict dialog: load the server copy into the editor. */
  saveConflictTakeServer: "save-conflict-take-server",
  /** Tailwind warnings panel in the designer. */
  classWarnings: "class-warnings",
  /** Designer toolbar: save the editor to the server. */
  designerSave: "designer-save",
  /** Designer sync bar: visibility switch (Public/Private). */
  templateVisibility: "template-visibility",
  /** Settings appearance: app name field. */
  settingsBrandName: "settings-brand-name",
  /** Settings appearance: density radio group. */
  settingsDensity: "settings-density",
  /** Settings appearance: logo upload button. */
  settingsLogoUpload: "settings-logo-upload",
  /** Settings local API: port field (device-local, never syncs). */
  settingsApiPort: "settings-api-port",
  /** Settings background: launch at startup toggle. */
  settingsLaunchAtStartup: "settings-launch-at-startup",
  /** Settings background: start minimized toggle. */
  settingsStartMinimized: "settings-start-minimized",
  /** Settings background: minimize-to-tray toggle. */
  settingsMinimizeToTray: "settings-minimize-to-tray",
  /** Settings background: close-to-tray toggle. */
  settingsCloseToTray: "settings-close-to-tray",
  /** Settings background (Android only): battery exemption button. */
  settingsBatteryExemption: "settings-battery-exemption",
  /** Settings fonts: upload button. */
  settingsFontUpload: "settings-font-upload",
  /** Settings retention: open the full-reset confirmation. */
  settingsResetDatabase: "settings-reset-database",
  /** Settings share: change-password fields and submit. */
  settingsChangePasswordCurrent: "settings-change-password-current",
  settingsChangePasswordNew: "settings-change-password-new",
  settingsChangePasswordConfirm: "settings-change-password-confirm",
  settingsChangePasswordSubmit: "settings-change-password-submit",
} as const;
