import type { UserRecord } from "../domain/ports.js";
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
