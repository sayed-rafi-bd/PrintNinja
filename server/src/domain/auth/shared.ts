import { ValidationError } from "../errors.js";

/** Handle rules, shared by the Zod schema (transport) and the domain
 * (last line of defence). v1 checked the same shape in main.rs; v2
 * keeps it byte-for-byte, including trimming before every check. */
export const HANDLE_MIN_LENGTH = 1;
export const HANDLE_MAX_LENGTH = 32;
export const HANDLE_PATTERN = /^[A-Za-z0-9_-]+$/;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** The match key: trimmed and lowercased. Case-insensitive matching
 * lives here, not in the database collation, so every query uses the
 * unique handle_key column. */
export function handleKey(handle: string): string {
	return handle.trim().toLowerCase();
}

export function assertValidHandle(field: string, handle: string): void {
	const trimmed = handle.trim();
	if (
		trimmed.length < HANDLE_MIN_LENGTH ||
		trimmed.length > HANDLE_MAX_LENGTH ||
		!HANDLE_PATTERN.test(trimmed)
	) {
		throw new ValidationError("Invalid handle", [
			{
				path: field,
				message: "Handle must be 1-32 of A-Z a-z 0-9 _ -",
			},
		]);
	}
}

export function assertValidPassword(field: string, password: string): void {
	if (
		password.length < PASSWORD_MIN_LENGTH ||
		password.length > PASSWORD_MAX_LENGTH
	) {
		throw new ValidationError("Invalid password", [
			{
				path: field,
				message: "Password must be 8-128 characters",
			},
		]);
	}
}
