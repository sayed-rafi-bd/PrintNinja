import { useCallback, useEffect, useState } from "react";
import {
	confirmAdoption,
	declineAdoption,
	ensureAdoptionChecked,
	getAdoptionState,
	type HeldRow,
} from "@/lib/sync/wiring";

/**
 * First-sync adoption (REFACTORING.md question 18): on a migrated
 * install, local-only rows wait for one decision instead of uploading
 * silently. The dialog confirms (push private now) or declines (push on
 * the normal schedule).
 */
export function useAdoption() {
	const [pending, setPending] = useState(false);
	const [rows, setRows] = useState<HeldRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let live = true;
		void ensureAdoptionChecked()
			.catch(() => {})
			.then(() => {
				if (!live) return;
				const state = getAdoptionState();
				setPending(state.hold);
				setRows(state.rows);
			});
		return () => {
			live = false;
		};
	}, []);

	const confirm = useCallback(async () => {
		setBusy(true);
		setError("");
		try {
			await confirmAdoption();
			const state = getAdoptionState();
			setPending(state.hold);
			setRows(state.rows);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	const decline = useCallback(async () => {
		setBusy(true);
		try {
			await declineAdoption();
		} finally {
			const state = getAdoptionState();
			setPending(state.hold);
			setRows(state.rows);
			setBusy(false);
		}
	}, []);

	return { pending, rows, busy, error, confirm, decline };
}
