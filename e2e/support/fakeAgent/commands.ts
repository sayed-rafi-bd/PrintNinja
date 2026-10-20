import { getSetting, setSetting } from "./store.js";

// In-memory implementation of the IPC commands, Phase 1 slice: the
// commands the sign-in and shell screens need (get_setting, set_setting
// plus the ping the boot path uses as a liveness check). Cache, data,
// print and job commands arrive with the phases that need them; each one
// lands here with the screen that calls it, never ahead of it.

type Handler = (args: Record<string, unknown>) => unknown;

const commands: Record<string, Handler> = {
	get_setting: (args) => getSetting(String(args.key ?? "")),
	set_setting: (args) => {
		const value = args.value;
		setSetting(String(args.key ?? ""), typeof value === "string" ? value : null);
		return null;
	},
	ping: () => null,
};

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
