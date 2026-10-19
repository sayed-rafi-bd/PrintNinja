import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Code, Eye, Database } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";


interface VisualDesignerProps {
  onHtmlChange: (html: string) => void;
  onCssChange: (css: string) => void;
  initialHtml: string;
  initialCss: string;
}

export function VisualDesigner({
  onHtmlChange,
  onCssChange,
  initialHtml,
  initialCss,
}: VisualDesignerProps) {
  const editorRef = useRef<any>(null);
  const [grapesLoaded, setGrapesLoaded] = useState(false);
  const [grapesFailed, setGrapesFailed] = useState(false);
  const [htmlCode, setHtmlCode] = useState(initialHtml);
  const [cssCode, setCssCode] = useState(initialCss);
  const syncDirectionRef = useRef<"visual" | "code">("visual");

  useEffect(() => {
    // Dynamically load GrapesJS
    const script = document.createElement("script");
    script.src = "https://unpkg.com/grapesjs@0.21.2/dist/grapes.min.js";
    script.onload = () => setGrapesLoaded(true);
    script.onerror = () => {
      console.warn("Failed to load GrapesJS, falling back to code editor");
      setGrapesFailed(true);
    };
    document.head.appendChild(script);

    const cssLink = document.createElement("link");
    cssLink.rel = "stylesheet";
    cssLink.href = "https://unpkg.com/grapesjs@0.21.2/dist/css/grapes.min.css";
    document.head.appendChild(cssLink);

    return () => {
      document.head.removeChild(script);
      document.head.removeChild(cssLink);
    };
  }, []);

  useEffect(() => {
    if (!grapesLoaded || !editorRef.current) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const grapesjs = (window as any).grapesjs;
      if (!grapesjs) return;

      const editor = grapesjs.init({
        container: editorRef.current,
        height: "500px",
        width: "auto",
        storageManager: false,
        canvas: {
          styles: [],
          scripts: [],
        },
        blockManager: {
          appendTo: "#blocks",
          blocks: [
            {
              id: "text",
              label: "Text",
              content: '<div data-gjs-type="text">Insert your text here</div>',
              category: "Basic",
            },
            {
              id: "image",
              label: "Image",
              content: '<img src="" alt="Image" />',
              category: "Basic",
            },
            {
              id: "table",
              label: "Table",
              content: '<table class="w-full"><tr><td>Cell</td><td>Cell</td></tr></table>',
              category: "Basic",
            },
            {
              id: "line",
              label: "Line",
              content: "<hr class='my-2' />",
              category: "Basic",
            },
            {
              id: "page-break",
              label: "Page Break",
              content: '<div style="page-break-after: always;"></div>',
              category: "Basic",
            },
          ],
        },
        deviceManager: {
          devices: [
            { name: "Desktop", width: "" },
            { name: "Mobile", width: "320px" },
          ],
        },
      });

      if (htmlCode) {
        editor.setComponents(htmlCode);
      }
      if (cssCode) {
        editor.setStyle(cssCode);
      }

      editor.on("change", () => {
        if (syncDirectionRef.current === "visual") {
          const html = editor.getHtml();
          const css = editor.getCss();
          setHtmlCode(html);
          setCssCode(css);
          onHtmlChange(html);
          onCssChange(css);
        }
      });

      editorRef.current.__grapes = editor;
    } catch (e) {
      console.error("GrapesJS init failed:", e);
    }
  }, [grapesLoaded]);

  const handleCodeChange = () => {
    syncDirectionRef.current = "code";
    onHtmlChange(htmlCode);
    onCssChange(cssCode);
    syncDirectionRef.current = "visual";
  };

  return (
    <div className="space-y-4">
      <Tabs defaultValue="visual" className="w-full">
        <TabsList>
          <TabsTrigger value="visual">
            <Eye className="h-4 w-4" />
            Visual
          </TabsTrigger>
          <TabsTrigger value="code">
            <Code className="h-4 w-4" />
            Code
          </TabsTrigger>
        </TabsList>

        <TabsContent value="visual">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Visual Canvas</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {grapesFailed && (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  The visual editor could not be loaded. It is downloaded from the internet, so it is not available
                  offline. You can still edit this template in the Code tab.
                </p>
              )}
              <div
                ref={editorRef}
                id="gjs-container"
                className={grapesFailed ? "hidden" : "min-h-[500px] border-0"}
              />
              <div id="blocks" className="hidden" />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="code" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">HTML</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <CodeMirror
                  value={htmlCode}
                  height="400px"
                  extensions={[html()]}
                  onChange={setHtmlCode}
                  theme="dark"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">CSS</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <CodeMirror
                  value={cssCode}
                  height="400px"
                  extensions={[css()]}
                  onChange={setCssCode}
                  theme="dark"
                />
              </CardContent>
            </Card>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleCodeChange}>
              <Database className="h-4 w-4" />
              Sync to Visual
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
