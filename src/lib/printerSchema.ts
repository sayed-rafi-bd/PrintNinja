import { z } from "zod";

/**
 * Shared add/edit validation for printers, used by the Setup panel for
 * both flows (the backend shares one rulebook too, but only for
 * type/language — address shapes are a UI concern and validated here).
 */

export const PRINTER_TYPES = [
  "ipp",
  "raw_tcp",
  "usb",
  "bluetooth",
  "system",
] as const;
export const PRINTER_LANGUAGES = [
  "pdf",
  "escpos",
  "tspl",
  "zpl",
  "cpcl",
  "raster",
] as const;

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[^\]]+\])$/i;

function addressError(printerType: string, address: string): string | null {
  switch (printerType) {
    case "ipp": {
      try {
        const url = new URL(address);
        if (url.protocol === "http:" || url.protocol === "https:") return null;
      } catch {
        /* fall through to the message */
      }
      return "printers.err_ipp_url";
    }
    case "raw_tcp": {
      const m = /^(.+):(\d{1,5})$/.exec(address);
      const port = m ? Number(m[2]) : NaN;
      if (
        !m ||
        !HOST_RE.test(m[1]) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        return "printers.err_raw_tcp";
      }
      return null;
    }
    default:
      // usb, bluetooth, system: device ids and names have no fixed shape.
      return null;
  }
}

const finitePositiveInt = (
  notNumberKey: string,
  notIntKey: string,
  minKey: string,
  maxKey: string,
  min: number,
  max: number,
) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : Number(v)),
    z
      .number({ invalid_type_error: notNumberKey })
      .int(notIntKey)
      .min(min, minKey)
      .max(max, maxKey)
      .refine((n) => Number.isFinite(n), {
        message: notNumberKey,
      }),
  );

export const printerFormSchema = z
  .object({
    name: z.string().trim().min(1, "printers.err_name_required"),
    printer_type: z.enum(PRINTER_TYPES, {
      errorMap: () => ({ message: "printers.err_unknown_type" }),
    }),
    address: z.string().trim().min(1, "printers.err_address_required"),
    language: z.enum(PRINTER_LANGUAGES, {
      errorMap: () => ({ message: "printers.err_unknown_language" }),
    }),
    paper_width_mm: finitePositiveInt(
      "printers.err_paper_number",
      "printers.err_paper_int",
      "printers.err_paper_min",
      "printers.err_paper_max",
      1,
      1000,
    ),
    dpi: finitePositiveInt(
      "printers.err_dpi_number",
      "printers.err_dpi_int",
      "printers.err_dpi_min",
      "printers.err_dpi_max",
      50,
      2400,
    ),
  })
  .superRefine((form, ctx) => {
    const err = addressError(form.printer_type, form.address);
    if (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["address"],
        message: err,
      });
    }
  });

export type PrinterForm = z.input<typeof printerFormSchema>;
export type ValidPrinterReq = z.output<typeof printerFormSchema>;

/** The panel keeps every field as a string; enums reject unknowns here. */
export interface LoosePrinterForm {
  name: string;
  printer_type: string;
  address: string;
  language: string;
  paper_width_mm: string;
  dpi: string;
}

/** One friendly message for the toast: the first failing field, as an i18n key. */
export function validatePrinterForm(
  form: LoosePrinterForm,
): { ok: true; req: ValidPrinterReq } | { ok: false; messageKey: string } {
  const parsed = printerFormSchema.safeParse(form);
  if (parsed.success) return { ok: true, req: parsed.data };
  return {
    ok: false,
    messageKey: parsed.error.issues[0]?.message ?? "printers.err_invalid",
  };
}
