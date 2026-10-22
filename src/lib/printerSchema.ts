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
      return "IPP address must be a full URL starting with http:// or https://";
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
        return "Raw TCP address must be host:port, e.g. 192.168.1.50:9100";
      }
      return null;
    }
    default:
      // usb, bluetooth, system: device ids and names have no fixed shape.
      return null;
  }
}

const finitePositiveInt = (label: string, min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : Number(v)),
    z
      .number({ invalid_type_error: `${label} must be a number` })
      .int(`${label} must be a whole number`)
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .refine((n) => Number.isFinite(n), {
        message: `${label} must be a number`,
      }),
  );

export const printerFormSchema = z
  .object({
    name: z.string().trim().min(1, "Printer name is required"),
    printer_type: z.enum(PRINTER_TYPES, {
      errorMap: () => ({ message: "Unknown printer type" }),
    }),
    address: z.string().trim().min(1, "Address is required"),
    language: z.enum(PRINTER_LANGUAGES, {
      errorMap: () => ({ message: "Unknown printer language" }),
    }),
    paper_width_mm: finitePositiveInt("Paper width", 1, 1000),
    dpi: finitePositiveInt("DPI", 50, 2400),
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

/** One friendly message for the toast: the first failing field. */
export function validatePrinterForm(
  form: LoosePrinterForm,
): { ok: true; req: ValidPrinterReq } | { ok: false; error: string } {
  const parsed = printerFormSchema.safeParse(form);
  if (parsed.success) return { ok: true, req: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues[0]?.message ?? "Invalid printer",
  };
}
