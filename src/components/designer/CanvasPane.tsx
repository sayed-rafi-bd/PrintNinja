import { Card, CardContent } from "@/components/ui/card";
import { renderTemplate } from "@/lib/render/renderTemplate";

interface Props {
  html: string;
  css: string;
  /** The template's compiled Tailwind CSS; "" until the first compile finishes. */
  compiledCss: string;
  /** The sample dataset the page is rendered with. */
  data: Record<string, unknown>;
  /** The page's size on screen in CSS pixels: page size in mm × zoom. */
  width: number;
  height: number;
}

/** The live page: the template rendered with the chosen sample data. */
export function CanvasPane({ html, css, compiledCss, data, width, height }: Props) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-center min-h-[500px] bg-muted rounded-b-lg overflow-auto">
          <div className="bg-white shadow-md border relative" style={{ width, height, transformOrigin: "top left" }}>
            <iframe
              srcDoc={renderTemplate(html, css, data, compiledCss)}
              sandbox=""
              className="pointer-events-none"
              title="Canvas preview"
              style={{ width: "100%", height: "100%", border: 0 }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
