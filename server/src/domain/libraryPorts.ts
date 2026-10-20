// Library record views (REFACTORING.md Phase 4): datasets, profiles,
// settings and fonts. Every row carries the owner's change sequence so
// the delta sync can merge it, exactly like templates.

export interface DatasetView {
	id: string;
	ownerId: string;
	name: string;
	dataJson: string;
	revision: number;
	changeSeq: bigint;
	createdAt: Date;
	updatedAt: Date;
}

export interface DatasetWrite {
	id: string;
	ownerId: string;
	name: string;
	dataJson: string;
}

export interface DatasetRepository {
	findById(id: string): Promise<DatasetView | null>;
	/** Creates the row with revision 1 and a fresh sequence number.
	 * A duplicate id (a retried create racing the first) reports
	 * revision_required, like templates. */
	create(input: DatasetWrite): Promise<DatasetView>;
	/** Checks expectedRevision, writes the row and bumps the revision,
	 * with a fresh sequence number. Throws RevisionConflictError with
	 * the stored revision on mismatch. */
	update(input: DatasetWrite, expectedRevision: number): Promise<DatasetView>;
	/** Deletes the row and writes the tombstone with a fresh sequence
	 * number, atomically. Returns the owner id, or null when missing. */
	deleteWithTombstone(id: string): Promise<{ ownerId: string } | null>;
	listByOwner(ownerId: string): Promise<DatasetView[]>;
}

export interface ProfileView {
	id: string;
	ownerId: string;
	templateId: string;
	printerName: string;
	settingsJson: string;
	revision: number;
	changeSeq: bigint;
	createdAt: Date;
	updatedAt: Date;
}

export interface ProfileWrite {
	id: string;
	ownerId: string;
	templateId: string;
	printerName: string;
	settingsJson: string;
}

export interface SettingView {
	ownerId: string;
	key: string;
	value: string;
	revision: number;
	changeSeq: bigint;
	updatedAt: Date;
}

export interface SettingWrite {
	ownerId: string;
	key: string;
	value: string;
}

export interface SettingRepository {
	findByKey(ownerId: string, key: string): Promise<SettingView | null>;
	create(input: SettingWrite): Promise<SettingView>;
	update(input: SettingWrite, expectedRevision: number): Promise<SettingView>;
	deleteWithTombstone(ownerId: string, key: string): Promise<boolean>;
	listByOwner(ownerId: string): Promise<SettingView[]>;
}

export interface FontView {
	id: string;
	ownerId: string;
	name: string;
	format: string;
	sizeBytes: number;
	sha256: string;
	revision: number;
	changeSeq: bigint;
	createdAt: Date;
	updatedAt: Date;
}

export interface UploadedFont extends FontView {
	bytes: Uint8Array;
}

export interface FontRepository {
	findById(id: string): Promise<FontView | null>;
	findFile(id: string): Promise<UploadedFont | null>;
	countByOwner(ownerId: string): Promise<number>;
	create(input: { id: string; ownerId: string; name: string }): Promise<FontView>;
	updateName(input: { id: string; ownerId: string; name: string }, expectedRevision: number): Promise<FontView>;
	replaceFile(input: { id: string; ownerId: string; bytes: Uint8Array; format: string; sha256: string }): Promise<UploadedFont>;
	deleteWithTombstone(id: string): Promise<{ ownerId: string } | null>;
	listByOwner(ownerId: string): Promise<FontView[]>;
}

export interface ProfileRepository {
	findById(id: string): Promise<ProfileView | null>;
	create(input: ProfileWrite): Promise<ProfileView>;
	update(input: ProfileWrite, expectedRevision: number): Promise<ProfileView>;
	deleteWithTombstone(id: string): Promise<{ ownerId: string } | null>;
	listByOwner(ownerId: string): Promise<ProfileView[]>;
}
