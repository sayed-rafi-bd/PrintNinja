import { z } from "zod";

// The error envelope (REFACTORING.md section 9). Every failure response in
// the API uses this shape; routes reference it in their error responses.

export const errorCode = z.enum([
  "validation_failed",
  "remote_reference",
  "payload_too_large",
  "unauthorized",
  "invalid_credentials",
  "forbidden",
  "not_found",
  "handle_taken",
  "revision_conflict",
  "revision_required",
  "quota_exceeded",
  "rate_limited",
  "internal_error",
]);

export const errorBody = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
    request_id: z.string(),
  }),
});

export type ErrorCode = z.infer<typeof errorCode>;
export type ErrorBody = z.infer<typeof errorBody>;
