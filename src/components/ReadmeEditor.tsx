import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { currentLanguage } from "@/lib/i18n";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const README_MAX_BYTES = 64 * 1024;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Remark plugin: drop HTML comments (`<!-- … -->`) from `html` nodes so
 * scaffold guidance never renders in the preview. Fenced code is a
 * `code` node, not `html`, so documented comment syntax in samples keeps
 * rendering verbatim; every other raw-HTML node keeps the existing
 * escaped-as-text behavior, so the no-rehype-raw XSS posture is unchanged.
 */
function stripHtmlComments() {
  const strip = (node: MdastNode): void => {
    const children = node.children;
    if (!children) return;
    for (const child of children) strip(child);
    node.children = children.filter((child) => {
      if (child.type !== "html" || typeof child.value !== "string") return true;
      const rest = child.value.replace(HTML_COMMENT_RE, "");
      if (rest.trim() === "") return false;
      child.value = rest;
      return true;
    });
  };
  return (tree: MdastNode): void => {
    strip(tree);
  };
}

interface ReadmeEditorProps {
  value: string;
  onChange: (value: string) => void;
  templateName: string;
  onReset?: () => void;
  scaffoldForName?: string;
}

function scaffoldFor(templateName: string): string {
  return `# ${templateName}

<!-- One line: what is this template for? -->

## What it prints
<!-- e.g. An 80mm thermal receipt with items, totals and a QR code. -->

## Data contract
<!-- The JSON keys this template reads. Keep in sync with Placeholders. -->

\`\`\`json
{
  "store":  { "name": "", "address": "" },
  "order":  { "number": "", "date": "" },
  "items":  [ { "name": "", "qty": 1, "price": 0.0, "total": 0.0 } ],
  "totals": { "subtotal": 0.0, "tax": 0.0, "total": 0.0 }
}
\`\`\`

## Placeholders
<!-- Which {{helper}} produces which field. -->

## Printer requirements
- Paper:
- Language:
- DPI:
- Margins:

## Changelog
- v1 — initial version
`;
}

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  placeholder: string = "",
): string {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end) || placeholder;
  const next =
    textarea.value.slice(0, start) +
    before +
    selected +
    after +
    textarea.value.slice(end);
  return next;
}

export function ReadmeEditor({
  value,
  onChange,
  templateName,
  onReset,
  scaffoldForName,
}: ReadmeEditorProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [showResetDialog, setShowResetDialog] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const bytes = new TextEncoder().encode(value).length;
  const overCap = bytes > README_MAX_BYTES;

  const applyWrap = (before: string, after: string, placeholder = "") => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = wrapSelection(ta, before, after, placeholder);
    onChange(next);
    // Restore focus and selection after React update
    requestAnimationFrame(() => {
      ta.focus();
      const start = ta.selectionStart;
      // Place cursor inside the wrapped placeholder if it was empty
      if (
        placeholder &&
        ta.value.slice(
          start - placeholder.length - after.length,
          start - after.length,
        ) === placeholder
      ) {
        ta.setSelectionRange(
          start - placeholder.length - after.length,
          start - after.length,
        );
      }
    });
  };

  const handleToolbar = (action: string) => {
    switch (action) {
      case "bold":
        applyWrap("**", "**", t("readme.ph_bold"));
        break;
      case "heading":
        applyWrap("\n## ", "", t("readme.ph_heading"));
        break;
      case "link":
        applyWrap("[", "](https://)", t("readme.ph_text"));
        break;
      case "code":
        applyWrap("`", "`", t("readme.ph_code"));
        break;
      case "codeblock":
        applyWrap("\n```\n", "\n```\n", t("readme.ph_code"));
        break;
      case "list":
        applyWrap("\n- ", "", t("readme.ph_item"));
        break;
      case "quote":
        applyWrap("\n> ", "", t("readme.ph_quote"));
        break;
      default:
        break;
    }
  };

  const handleReset = () => {
    const scaffold = scaffoldFor(scaffoldForName ?? templateName);
    if (onReset) {
      onReset();
    } else {
      onChange(scaffold);
    }
    setShowResetDialog(false);
  };

  const preview = (
    <div className="prose prose-sm max-w-none p-4 border rounded-md bg-card min-h-[300px] overflow-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, stripHtmlComments]}
        // No rehype-raw: raw HTML stays as text, which is the XSS guarantee
        components={{
          a: ({ href, children, ...props }) => {
            const safe = href && /^(https?:\/\/|mailto:)/i.test(href);
            if (!safe) {
              return <span {...props}>{children}</span>;
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {value || t("readme.empty_hint")}
      </ReactMarkdown>
    </div>
  );

  const editor = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1 p-1 border rounded-md bg-muted/30">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("bold")}
          title={t("readme.tool_bold")}
        >
          <strong>B</strong>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("heading")}
          title={t("readme.tool_heading")}
        >
          H
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("link")}
          title={t("readme.tool_link")}
        >
          🔗
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("code")}
          title={t("readme.tool_code")}
        >
          {"</>"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("codeblock")}
          title={t("readme.tool_codeblock")}
        >
          {"```"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("list")}
          title={t("readme.tool_list")}
        >
          • {t("readme.list_label")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => handleToolbar("quote")}
          title={t("readme.tool_quote")}
        >
          ❝
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowResetDialog(true)}
          title={t("readme.tool_reset")}
        >
          {t("readme.reset")}
        </Button>
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("readme.placeholder")}
        className="min-h-[300px] font-mono text-sm"
        rows={16}
      />
      <div
        className={`text-xs ${overCap ? "text-destructive font-medium" : "text-muted-foreground"}`}
      >
        {t("readme.byte_count", {
          used: bytes.toLocaleString(currentLanguage()),
          max: README_MAX_BYTES.toLocaleString(currentLanguage()),
        })}
        {overCap && t("readme.over_cap")}
      </div>
    </div>
  );

  return (
    <>
      {/* Edit and preview share one pane: the preview renders on demand
        instead of live beside the editor. */}
      <div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="edit">{t("readme.edit")}</TabsTrigger>
            <TabsTrigger value="preview">{t("readme.preview")}</TabsTrigger>
          </TabsList>
          <div className="mt-4">{tab === "edit" ? editor : preview}</div>
        </Tabs>
      </div>

      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("readme.reset_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("readme.reset_body")}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleReset}>
              {t("readme.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { README_MAX_BYTES, scaffoldFor };
