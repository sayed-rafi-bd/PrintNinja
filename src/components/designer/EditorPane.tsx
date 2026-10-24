import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import CodeMirror, {
  type EditorView,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { EditorView as CmView } from "@codemirror/view";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ReadmePanel } from "./ReadmePanel";

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
};

interface CodeProps {
  templateName: string;
  htmlCode: string;
  cssCode: string;
  onHtmlChange: (value: string) => void;
  onCssChange: (value: string) => void;
}

/**
 * The HTML and CSS editors stacked one above the other, for the Code tab on a
 * phone, where there is no room for a side-by-side workspace. Lines wrap,
 * the editors grow with the content up to 60vh, and Done dismisses the
 * soft keyboard.
 */
export function CodeEditors({
  templateName,
  htmlCode,
  cssCode,
  onHtmlChange,
  onCssChange,
}: CodeProps) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            (document.activeElement as HTMLElement | null)?.blur?.()
          }
        >
          Done
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">HTML — {templateName}</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden rounded-md border p-0">
            <CodeMirror
              value={htmlCode}
              height="auto"
              extensions={[html(), CmView.lineWrapping]}
              onChange={onHtmlChange}
              theme="dark"
              style={{ fontSize: "13px", maxHeight: "60vh" }}
              basicSetup={BASIC_SETUP}
              aria-label="HTML editor"
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
              height="auto"
              extensions={[css(), CmView.lineWrapping]}
              onChange={onCssChange}
              theme="dark"
              style={{ fontSize: "13px", maxHeight: "60vh" }}
              basicSetup={BASIC_SETUP}
              aria-label="CSS editor"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type EditorTab = "html" | "css" | "readme" | "sample";

/** What a parent can ask the editor pane to do. */
export interface EditorPaneHandle {
  /**
   * Insert `text` at the HTML editor's cursor (replacing any selection), then
   * leave the cursor `back` characters before the end of the inserted text.
   * Switches to the HTML tab first, since that is where helpers go.
   */
  insertAtCursor: (text: string, back?: number) => void;
}

interface Props extends CodeProps {
  readme: string;
  onReadmeChange: (value: string) => void;
  readmeSaving: boolean;
  onSaveReadme: () => void;
  /** Shown under the tabs while the HTML or CSS tab is open, such as the class-name warnings. */
  notices?: ReactNode;
  className?: string;
  /** Content of the Sample data tab, after HTML / CSS / README. When omitted the tab is hidden. */
  samplePanel?: ReactNode;
}

/**
 * The desktop editor: HTML, CSS, README and (optionally) sample data as tabs
 * in one pane that fills its parent and scrolls on its own. Both code
 * editors stay mounted, so switching tabs keeps each one's cursor, scroll
 * position and undo history.
 */
export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane(
    {
      templateName,
      htmlCode,
      cssCode,
      onHtmlChange,
      onCssChange,
      readme,
      onReadmeChange,
      readmeSaving,
      onSaveReadme,
      notices,
      samplePanel,
      className,
    },
    ref,
  ) {
    const htmlEditor = useRef<ReactCodeMirrorRef>(null);
    const [tab, setTab] = useState<EditorTab>("html");

    // CodeMirror creates its view a moment after it mounts. An insert asked for
    // before then (the pane has just come back from canvas-only) waits here.
    const pendingInsert = useRef<{ text: string; back: number } | null>(null);

    const applyInsert = (view: EditorView, text: string, back: number) => {
      const { from, to } = view.state.selection.main;
      // Dispatching fires the editor's change listener, so the page state and
      // the canvas update exactly as if the text had been typed.
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length - back },
      });
      // The HTML tab may have been hidden a moment ago; focus once it is shown.
      setTimeout(() => view.focus(), 0);
    };

    useImperativeHandle(
      ref,
      () => ({
        insertAtCursor(text, back = 0) {
          setTab("html");
          const view = htmlEditor.current?.view;
          if (view) applyInsert(view, text, back);
          else pendingInsert.current = { text, back };
        },
      }),
      [],
    );

    // `data-[state=inactive]:hidden` rather than the `hidden` attribute alone: a
    // display class on the element would otherwise win over it.
    const pane = "mt-0 min-h-0 flex-1 data-[state=inactive]:hidden";
    // Class warnings describe the HTML/CSS, so they only show on those tabs.
    const showNotices = tab === "html" || tab === "css";
    return (
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as EditorTab)}
        className={cn(
          "flex h-full min-h-0 flex-col overflow-hidden rounded-lg border bg-card",
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
          <TabsList
            aria-label="Editor files"
            className="min-h-8 w-max gap-0.5 p-0.5"
          >
            <TabsTrigger value="html" className="h-7 px-3 text-xs">
              HTML
            </TabsTrigger>
            <TabsTrigger value="css" className="h-7 px-3 text-xs">
              CSS
            </TabsTrigger>
            <TabsTrigger value="readme" className="h-7 px-3 text-xs">
              README
            </TabsTrigger>
            {samplePanel !== undefined && (
              <TabsTrigger value="sample" className="h-7 px-3 text-xs">
                Sample data
              </TabsTrigger>
            )}
          </TabsList>
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={templateName}
          >
            {templateName}
          </span>
        </div>
        {showNotices && notices && (
          <div className="max-h-40 shrink-0 overflow-auto border-b p-2">
            {notices}
          </div>
        )}
        <TabsContent value="html" forceMount className={pane}>
          <CodeMirror
            ref={htmlEditor}
            onCreateEditor={(view) => {
              const pending = pendingInsert.current;
              if (!pending) return;
              pendingInsert.current = null;
              applyInsert(view, pending.text, pending.back);
            }}
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
        <TabsContent
          value="readme"
          className="mt-0 min-h-0 flex-1 overflow-auto p-3"
        >
          <ReadmePanel
            readme={readme}
            onChange={onReadmeChange}
            templateName={templateName}
            saving={readmeSaving}
            onSave={onSaveReadme}
          />
        </TabsContent>
        {samplePanel !== undefined && (
          <TabsContent
            value="sample"
            className="mt-0 min-h-0 flex-1 overflow-auto p-3"
          >
            {samplePanel}
          </TabsContent>
        )}
      </Tabs>
    );
  },
);
