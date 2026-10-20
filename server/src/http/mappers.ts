import type { UserRecord } from "../domain/ports.js";
import type {
	TemplateSummaryView,
	TemplateView,
	VersionSummaryView,
	VersionView,
} from "../domain/templatePorts.js";
import type { ManifestItem as SavedManifestItem } from "../domain/templates/saved.js";
import type { SyncChange } from "../domain/syncPorts.js";
import type {
	ManifestItemResponse,
	SyncChangeResponse,
} from "./schemas/sync.js";
import type {
	TemplateResponse,
	TemplateSummaryResponse,
	VersionResponse,
	VersionSummaryResponse,
} from "./schemas/templates.js";
import type { AuthResponse, UserResponse } from "./schemas/auth.js";

// Domain object to response shape (REFACTORING.md section 5). Dates
// leave the service as RFC 3339 UTC with Z (P16: no local-time text).
export function toUserResponse(user: UserRecord): UserResponse {
	return {
		id: user.id,
		handle: user.handle,
		created_at: user.createdAt.toISOString(),
	};
}

export function toAuthResponse(
	user: UserRecord,
	token: string,
	expiresAt: Date,
): AuthResponse {
	return {
		token,
		expires_at: expiresAt.toISOString(),
		user: toUserResponse(user),
	};
}

/**
 * Template views carry the internal changeSeq (bigint, unserializable);
 * the wire shapes omit it — the cursor is opaque to the client.
 */
export function toTemplateSummary(view: TemplateSummaryView): TemplateSummaryResponse {
	return {
		id: view.id,
		owner_id: view.ownerId,
		owner_handle: view.ownerHandle,
		name: view.name,
		summary: view.summary,
		page_w_mm: view.pageWMm,
		page_h_mm: view.pageHMm,
		language: view.language,
		use_count: view.useCount,
		revision: view.revision,
		version_count: view.versionCount,
		published_at: view.publishedAt?.toISOString() ?? null,
		updated_at: view.updatedAt.toISOString(),
	};
}

export function toTemplate(view: TemplateView): TemplateResponse {
	return {
		...toTemplateSummary(view),
		body: view.body,
		css: view.css,
		readme: view.readme,
	};
}

export function toVersionSummary(view: VersionSummaryView): VersionSummaryResponse {
	return {
		version_no: view.versionNo,
		created_by: view.createdBy,
		label: view.label,
		note: view.note,
		created_at: view.createdAt.toISOString(),
	};
}

export function toVersion(view: VersionView): VersionResponse {
	return {
		...toVersionSummary(view),
		body: view.body,
		css: view.css,
	};
}

export function toSyncChange(change: SyncChange): SyncChangeResponse {
	if ("entityKey" in change) {
		return {
			seq: change.seq.toString(10),
			entity: change.entity,
			op: "delete",
			id: change.entityKey,
		};
	}
	return {
		seq: change.seq.toString(10),
		entity: "template",
		op: "upsert",
		data: {
			...toTemplate(change.data),
			head_version_no: change.headVersionNo,
		},
	};
}

export function toManifestItem(item: SavedManifestItem): ManifestItemResponse {
	return {
		id: item.id,
		revision: item.revision,
		state: item.state,
		owner_handle: item.ownerHandle,
		updated_at: item.updatedAt.toISOString(),
	};
}
