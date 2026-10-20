import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { notifyLocalEdit, useSyncStatus } from "@/lib/sync/useSyncStatus";
import type { EngineApi, EngineCache, LibraryApi, LibraryCache } from "@/lib/sync/engine";

function fakes(over: { cache?: Partial<EngineCache>; api?: Partial<EngineApi> } = {}) {
	const cache: EngineCache = {
		getCursor: async () => "",
		listDirty: async () => [],
		listTombstoned: async () => [],
		listSynced: async () => [],
		applyChanges: async () => ({ applied_upserts: 0, applied_deletes: 0, skipped_dirty: 0 }),
		markPushed: async () => {},
		markConflicted: async () => {},
		forgetTemplate: async () => true,
		listQueuedUses: async () => [],
		drainUse: async () => {},
		...over.cache,
	};
	const api: EngineApi = {
		fetchChanges: async () => ({ changes: [], next_cursor: "MQ==", has_more: false, reset: false }),
			fetchTemplate: async () => ({ revision: 1 }),
		putTemplate: async () => ({ revision: 1 }),
		deleteTemplate: async () => {},
		postUse: async () => {},
		...over.api,
	};
	const libraryCache: LibraryCache = {
		listDirtyDatasets: async () => [],
		listDirtyProfiles: async () => [],
		listDirtySettings: async () => [],
		listDirtyFonts: async () => [],
		listTombstonedDatasets: async () => [],
		listTombstonedProfiles: async () => [],
		listTombstonedSettings: async () => [],
		listTombstonedFonts: async () => [],
		listSyncedDatasets: async () => [],
		listSyncedProfiles: async () => [],
		listSyncedSettings: async () => [],
		listSyncedFonts: async () => [],
		markDatasetPushed: async () => {},
		markProfilePushed: async () => {},
		markSettingPushed: async () => {},
		markFontPushed: async () => {},
		forgetDataset: async () => true,
		forgetProfile: async () => true,
		forgetSetting: async () => true,
		forgetFont: async () => true,
		readFontFile: async () => [],
		downloadPendingFonts: async () => ({ downloaded: 0, failed: 0 }),
	};
	const libraryApi: LibraryApi = {
		putDataset: async () => ({ revision: 1 }),
		deleteDataset: async () => {},
		putProfile: async () => ({ revision: 1 }),
		deleteProfile: async () => {},
		putSetting: async () => ({}),
		deleteSetting: async () => {},
		putFont: async () => ({ revision: 1 }),
		putFontFile: async () => ({ revision: 2 }),
		deleteFont: async () => {},
	};
	return { cache, api, library: { cache: libraryCache, api: libraryApi } };
}

function Probe(props: { cache?: EngineCache; api?: EngineApi }) {
	const faked = fakes();
	const status = useSyncStatus({
		cache: props.cache ?? faked.cache,
		api: props.api ?? faked.api,
		library: faked.library,
	});
	return <p data-testid="sync">{`${status.state}:${status.pending}:${status.conflicts}`}</p>;
}

describe("useSyncStatus", () => {
	it("starts syncing and settles synced on a clean account", async () => {
		const { cache, api } = fakes();
		render(<Probe cache={cache} api={api} />);
		expect(screen.getByTestId("sync")).toHaveTextContent("syncing");
		await waitFor(() => expect(screen.getByTestId("sync")).toHaveTextContent(/^synced:0:0$/));
	});

	it("reports offline when the first pull fails", async () => {
		const { cache, api } = fakes({
			api: {
				fetchChanges: async () => {
					throw new Error("down");
				},
				putTemplate: async () => ({ revision: 1 }),
				deleteTemplate: async () => {},
				postUse: async () => {},
			},
		});
		render(<Probe cache={cache} api={api} />);
		await waitFor(() => expect(screen.getByTestId("sync")).toHaveTextContent(/^offline/));
	});

	it("notifyLocalEdit without a mounted scheduler is a safe no-op", async () => {
		expect(() => notifyLocalEdit()).not.toThrow();
	});
});
