import { z } from "zod";
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../domain/auth/index.js";

// Endpoints 1-4: register, login, logout, me (plan section 9).
// Register and login share one credential shape: v1 validated the
// handle charset only on register, but an empty or malformed credential
// is a 400 either way in v2, so one schema serves both and the domain
// re-checks the same rules as the last line of defence.

export const authCredentials = z.object({
  handle: z
    .string()
    .trim()
    .min(HANDLE_MIN_LENGTH)
    .max(HANDLE_MAX_LENGTH)
    .regex(HANDLE_PATTERN, "Handle must be 1-32 of A-Z a-z 0-9 _ -")
    .meta({ examples: ["Rafi"] }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH)
    .meta({
      examples: ["correct horse battery"],
    }),
});

export const userSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  created_at: z.string().datetime(),
});

export const authResponse = z.object({
  token: z.string().min(1),
  expires_at: z.string().datetime(),
  user: userSchema,
});

export type AuthCredentials = z.infer<typeof authCredentials>;
export type UserResponse = z.infer<typeof userSchema>;
export type AuthResponse = z.infer<typeof authResponse>;
