import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@/lib/i18n";
import { ReadmeEditor, scaffoldFor } from "@/components/ReadmeEditor";

// Radix Tabs switch on mousedown, not click.
function openPreview() {
  const tab = screen.getByRole("tab", { name: "Preview" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

describe("ReadmeEditor preview", () => {
  it("does not display HTML scaffold comments", () => {
    render(
      <ReadmeEditor
        value={scaffoldFor("Label")}
        onChange={vi.fn()}
        templateName="Label"
      />,
    );
    openPreview();
    // Guidance comments are authoring notes, never rendered output.
    expect(
      screen.queryByText(/One line: what is this template for\?/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/e\.g\. An 80mm/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Which \{\{helper\}\} produces/),
    ).not.toBeInTheDocument();
  });

  it("still renders headings, code blocks and lists", () => {
    render(
      <ReadmeEditor
        value={scaffoldFor("Label")}
        onChange={vi.fn()}
        templateName="Label"
      />,
    );
    openPreview();
    expect(
      screen.getByRole("heading", { name: "What it prints" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/"store"/)).toBeInTheDocument();
    expect(screen.getByText("Paper:")).toBeInTheDocument();
  });

  it("strips multi-line comments too", () => {
    render(
      <ReadmeEditor
        value={"# T\n\n<!--\nMulti\nline\n-->\n\nDone.\n"}
        onChange={vi.fn()}
        templateName="Label"
      />,
    );
    openPreview();
    expect(screen.queryByText(/Multi/)).not.toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });

  it("keeps comments verbatim inside fenced code", () => {
    render(
      <ReadmeEditor
        value={
          "# T\n\nText <!-- inline note --> more.\n\n```html\n<!-- in code -->\n```\n\nDone.\n"
        }
        onChange={vi.fn()}
        templateName="Label"
      />,
    );
    openPreview();
    expect(screen.queryByText(/inline note/)).not.toBeInTheDocument();
    expect(screen.getByText(/in code/)).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });
});
