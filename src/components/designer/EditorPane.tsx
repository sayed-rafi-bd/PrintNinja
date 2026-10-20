import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  templateName: string;
  htmlCode: string;
  cssCode: string;
  onHtmlChange: (value: string) => void;
  onCssChange: (value: string) => void;
}

const BASIC_SETUP = { lineNumbers: true, foldGutter: true, highlightActiveLine: true };

/** The HTML and CSS code editors for the template being edited. */
export function EditorPane({ templateName, htmlCode, cssCode, onHtmlChange, onCssChange }: Props) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">HTML — {templateName}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 border rounded-md overflow-hidden">
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
        <CardContent className="p-0 border rounded-md overflow-hidden">
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
