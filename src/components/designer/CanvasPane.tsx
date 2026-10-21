import { renderTemplate } from "@/lib/render/renderTemplate";

interface Props {
  html: string;
  css: string;
  /** The template's compiled Tailwind CSS; "" until the first compile finishes. */
  compiledCss: string;
  /** The sample dataset the page is rendered with. */
  data: Record<string, unknown>;
  /** The page's true size in CSS pixels: page size in mm × 3.7795. Not scaled by zoom. */
  width: number;
  height: number;
  /** How much to scale the page on screen. The page is laid out at its true size and then scaled, so zoom never reflows it. */
  zoom?: number;
}

/** The live page: the template rendered with the chosen sample data. */
export function CanvasPane({
  html,
  css,
  compiledCss,
  data,
  width,
  height,
  zoom = 1,
}: Props) {
  return (
    // The outer box takes the scaled size so scrolling matches what is drawn.
    <div
      className="relative shrink-0 bg-white shadow-md ring-1 ring-border"
      style={{ width: width * zoom, height: height * zoom }}
    >
      <div
        style={{
          width,
          height,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}
      >
        <iframe
          srcDoc={renderTemplate(html, css, data, compiledCss)}
          sandbox=""
          className="pointer-events-none"
          title="Canvas preview"
          style={{ width: "100%", height: "100%", border: 0 }}
        />
      </div>
    </div>
  );
}
