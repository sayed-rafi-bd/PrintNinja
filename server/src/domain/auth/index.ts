export { registerUser } from "./register.js";
export type { RegisterInput, RegisterResult } from "./register.js";
export { loginUser } from "./login.js";
export type { LoginInput, LoginResult } from "./login.js";
export { logoutUser, purgeExpiredSessions, validateSession } from "./session.js";
export type { SessionResult } from "./session.js";
export {
	HANDLE_MAX_LENGTH,
	HANDLE_MIN_LENGTH,
	HANDLE_PATTERN,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	assertValidHandle,
	assertValidPassword,
	handleKey,
} from "./shared.js";
