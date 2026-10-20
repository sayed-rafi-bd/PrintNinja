import { getSetting, setSetting } from "./store.js";
import { createFakeCache, type SyncChangeIn } from "./cache.js";

// In-memory implementation of the IPC commands. Phase 1 implements the
// commands the sign-in and shell screens need; every other command the
// Rust backend offers is registered as an acknowledged stub (warn and
// null) so the agent contract test pins the full surface and drift is
// visible. Real behavior lands here with the screen that calls it,
// never ahead of it — the F-series specs prove each phase's behavior.
//
// The sync cache is the exception: one module holds the whole behavior
// so the shared cache_cases.json runs identically here and in Rust.

type Handler = (args: Record<string, unknown>) => unknown;

// One cache per browser context (module scope = the injected page).
const cache = createFakeCache();

const implemented: Record<string, Handler> = {
	get_setting: (args) => getSetting(String(args.key ?? "")),
	set_setting: (args) => {
		const value = args.value;
		setSetting(String(args.key ?? ""), typeof value === "string" ? value : null);
		return null;
	},
	ping: () => null,
	cache_apply_changes: (args) =>
		cache.applyChanges(
			(args["changes"] as SyncChangeIn[] | undefined) ?? [],
			String(args["new_cursor"] ?? ""),
		),
	cache_get_sync_state: () => cache.getSyncState(),
	cache_list_dirty: () => cache.listDirty(),
	cache_mark_pushed: (args) => {
		cache.markPushed(String(args["server_id"] ?? ""), Number(args["revision"] ?? 0));
		return null;
	},
	cache_mark_conflicted: (args) => {
		cache.markConflicted(String(args["server_id"] ?? ""));
		return null;
	},
	cache_resolve_conflict: (args) => {
		const resolution = args["resolution"];
		if (resolution !== "theirs" && resolution !== "mine") {
			throw new Error(`unknown resolution: ${String(resolution)}`);
		}
		cache.resolveConflict(
			String(args["server_id"] ?? ""),
			resolution,
			(args["server_copy"] as Record<string, unknown> | undefined),
		);
		return null;
	},
	cache_queue_use: (args) => {
		return cache.queueUse(String(args["server_id"] ?? ""), Number(args["delta"] ?? 0));
	},
	cache_list_queued_uses: () => cache.listQueuedUses(),
	cache_clear_account: () => cache.clearAccount(),
	cache_list_tombstoned: () => cache.listTombstoned(),
	cache_list_synced: () => cache.listSynced(),
	cache_forget_template: (args) => {
		return cache.forgetTemplate(String(args["server_id"] ?? ""));
	},
};

/** Every Rust command without real behavior yet (src-tauri/src/lib.rs).
 * Keep this list in sync with generate_handler! — the contract test
 * fails when a Rust command is neither implemented nor acknowledged. */
const acknowledgedStubs: string[] = [
	"list_printers",
	"add_printer",
	"delete_printer",
	"get_printer",
	"test_printer",
	"list_templates",
	"create_template",
	"get_template",
	"update_readme",
	"update_template_meta",
	"set_publish_info",
	"clear_publish_info",
	"update_template_origin",
	"delete_template",
	"list_jobs",
	"get_job",
	"reprint_job",
	"retry_job",
	"delete_job",
	"get_trusted_sources",
	"set_trusted_sources",
	"print_html",
	"enumerate_system_printers",
	"spike_test_print",
	"list_versions",
	"create_version",
	"delete_version",
	"restore_version",
	"diff_versions",
	"list_fonts",
	"upload_font",
	"delete_font",
	"list_profiles",
	"save_profile",
	"delete_profile",
	"create_batch",
	"list_batches",
	"get_batch",
	"cancel_batch",
	"retry_batch",
	"start_api_server",
	"stop_api_server",
	"get_api_status",
	"regenerate_api_key",
	"parse_deeplink",
];

const commands: Record<string, Handler> = { ...implemented };
for (const name of acknowledgedStubs) {
	commands[name] = () => {
		console.warn(`[fake-agent] ${name} has no behavior yet (Phase 1 stub)`);
		return null;
	};
}

export function commandNames(): string[] {
	return Object.keys(commands);
}

export function handleCommand(cmd: string, args: unknown): unknown {
	const handler = commands[cmd];
	if (!handler) {
		console.warn("[fake-agent] unhandled command", cmd, args);
		return null;
	}
	const record =
		typeof args === "object" && args !== null
			? (args as Record<string, unknown>)
			: {};
	return handler(record);
}
