import { useState, type ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ReadmePanel } from "./ReadmePanel";

const BASIC_SETUP = { lineNumbers: true, foldGutter: true, highlightActiveLine: true };

interface CodeProps {
  templateName: string;
  htmlCode: string;
  cssCode: string;
  onHtmlChange: (value: string) => void;
  onCssChange: (value: string) => void;
}

/**
 * The HTML and CSS editors stacked one above the other, for the Code tab on a
 * phone, where there is no room for a side-by-side workspace.
 */
export function CodeEditors({ templateName, htmlCode, cssCode, onHtmlChange, onCssChange }: CodeProps) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">HTML — {templateName}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-hidden rounded-md border p-0">
          <CodeMirror
            value={htmlCode}
            height="520px"
            extensions={[html()]}
            onChange={onHtmlChange}
            theme="dark"
            style={{ fontSize: "13px" }}
            basicSetup={BASIC_SETUP}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">CSS</CardTitle>
        </CardHeader>
        <CardContent className="overflow-hidden rounded-md border p-0">
          <CodeMirror
            value={cssCode}
            height="520px"
            extensions={[css()]}
            onChange={onCssChange}
            theme="dark"
            style={{ fontSize: "13px" }}
            basicSetup={BASIC_SETUP}
          />
        </CardContent>
      </Card>
    </div>
  );
}

type EditorTab = "html" | "css" | "readme";

interface Props extends CodeProps {
  readme: string;
  onReadmeChange: (value: string) => void;
  readmeSaving: boolean;
  onSaveReadme: () => void;
  /** Shown under the tabs while the HTML or CSS tab is open, such as the class-name warnings. */
  notices?: ReactNode;
  className?: string;
}

/**
 * The desktop editor: HTML, CSS and README as tabs in one pane that fills its
 * parent and scrolls on its own. Both code editors stay mounted, so switching
 * tabs keeps each one's cursor, scroll position and undo history.
 */
export function EditorPane({
  templateName, htmlCode, cssCode, onHtmlChange, onCssChange,
  readme, onReadmeChange, readmeSaving, onSaveReadme, notices, className,
}: Props) {
  const [tab, setTab] = useState<EditorTab>("html");
  // `data-[state=inactive]:hidden` rather than the `hidden` attribute alone: a
  // display class on the element would otherwise win over it.
  const pane = "mt-0 min-h-0 flex-1 data-[state=inactive]:hidden";
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)} className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <TabsList aria-label="Editor files" className="h-8 w-max gap-0.5 p-0.5">
          <TabsTrigger value="html" className="h-7 px-3 text-xs">HTML</TabsTrigger>
          <TabsTrigger value="css" className="h-7 px-3 text-xs">CSS</TabsTrigger>
          <TabsTrigger value="readme" className="h-7 px-3 text-xs">README</TabsTrigger>
        </TabsList>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={templateName}>{templateName}</span>
      </div>
      {tab !== "readme" && notices && <div className="max-h-40 shrink-0 overflow-auto border-b p-2">{notices}</div>}
      <TabsContent value="html" forceMount className={pane}>
        <CodeMirror
          className="h-full"
          value={htmlCode}
          height="100%"
          extensions={[html()]}
          onChange={onHtmlChange}
          theme="dark"
          style={{ fontSize: "13px" }}
          basicSetup={BASIC_SETUP}
          aria-label="HTML editor"
        />
      </TabsContent>
      <TabsContent value="css" forceMount className={pane}>
        <CodeMirror
          className="h-full"
          value={cssCode}
          height="100%"
          extensions={[css()]}
          onChange={onCssChange}
          theme="dark"
          style={{ fontSize: "13px" }}
          basicSetup={BASIC_SETUP}
          aria-label="CSS editor"
        />
      </TabsContent>
      <TabsContent value="readme" className="mt-0 min-h-0 flex-1 overflow-auto p-3">
        <ReadmePanel readme={readme} onChange={onReadmeChange} templateName={templateName} saving={readmeSaving} onSave={onSaveReadme} />
      </TabsContent>
    </Tabs>
  );
}
