declare module "bwip-js" {
  interface RenderOptions {
    bcid: string;
    text: string;
    scale?: number;
    height?: number;
    width?: number;
    includetext?: boolean;
    textxalign?: string;
    paddingwidth?: number;
    paddingheight?: number;
  }

  export function toCanvas(
    canvas: HTMLCanvasElement,
    options: RenderOptions,
  ): void;

  export function toSVG(options: RenderOptions): string;
}
