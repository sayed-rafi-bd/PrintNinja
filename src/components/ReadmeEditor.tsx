import { useState, useRef } from "react";
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
  const next = textarea.value.slice(0, start) + before + selected + after + textarea.value.slice(end);
  return next;
}

export function ReadmeEditor({ value, onChange, templateName, onReset, scaffoldForName }: ReadmeEditorProps) {
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
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
      if (placeholder && ta.value.slice(start - placeholder.length - after.length, start - after.length) === placeholder) {
        ta.setSelectionRange(start - placeholder.length - after.length, start - after.length);
      }
    });
  };

  const handleToolbar = (action: string) => {
    switch (action) {
      case "bold":
        applyWrap("**", "**", "bold");
        break;
      case "heading":
        applyWrap("\n## ", "", "Heading");
        break;
      case "link":
        applyWrap("[", "](https://)", "text");
        break;
      case "code":
        applyWrap("`", "`", "code");
        break;
      case "codeblock":
        applyWrap("\n```\n", "\n```\n", "code");
        break;
      case "list":
        applyWrap("\n- ", "", "item");
        break;
      case "quote":
        applyWrap("\n> ", "", "quote");
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
        remarkPlugins={[remarkGfm]}
        // No rehype-raw: raw HTML stays as text, which is the XSS guarantee
        components={{
          a: ({ href, children, ...props }) => {
            const safe = href && /^(https?:\/\/|mailto:)/i.test(href);
            if (!safe) {
              return <span {...props}>{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {value || "*Empty README — write something*"}
      </ReactMarkdown>
    </div>
  );

  const editor = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1 p-1 border rounded-md bg-muted/30">
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("bold")} title="Bold">
          <strong>B</strong>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("heading")} title="Heading">
          H
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("link")} title="Link">
          🔗
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("code")} title="Inline code">
          {"</>"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("codeblock")} title="Code block">
          {"```"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("list")} title="List">
          • List
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handleToolbar("quote")} title="Quote">
          ❝
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setShowResetDialog(true)} title="Reset to scaffold">
          Reset
        </Button>
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your README in Markdown..."
        className="min-h-[300px] font-mono text-sm"
        rows={16}
      />
      <div className={`text-xs ${overCap ? "text-destructive font-medium" : "text-muted-foreground"}`}>
        {bytes.toLocaleString()} / {README_MAX_BYTES.toLocaleString()} bytes
        {overCap && " — exceeds 64 KiB cap"}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile: tabbed, Desktop: split */}
      <div className="lg:hidden">
        <Tabs value={mobileTab} onValueChange={(v) => setMobileTab(v as typeof mobileTab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <div className="mt-4">
            {mobileTab === "edit" ? editor : preview}
          </div>
        </Tabs>
      </div>

      <div className="hidden lg:grid lg:grid-cols-2 gap-4">
        <div>{editor}</div>
        <div>{preview}</div>
      </div>

      <Dialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset README to scaffold?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will replace the current README with the default scaffold. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResetDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReset}>
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { README_MAX_BYTES, scaffoldFor };
