import { z } from "zod";
import { ERROR_CODES } from "../../domain/errors.js";

// The error envelope (REFACTORING.md section 9). Every failure response in
// the API uses this shape; routes reference it in their error responses.
// The code list itself lives in the domain — this schema only restates it
// as Zod so it can ride into the OpenAPI document.

export const errorCode = z.enum(ERROR_CODES);

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
