import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useEffect } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { AppRouter } from "@/App";
import { startOnPrint } from "@/lib/shell/startRoute";

function visit(url: string) {
  window.history.replaceState(null, "", url);
}

describe("startOnPrint", () => {
  it("rewrites a bare / to /print, keeping the query and hash", () => {
    visit("/?from=launcher#x");
    startOnPrint();
    expect(window.location.pathname).toBe("/print");
    expect(window.location.search).toBe("?from=launcher");
    expect(window.location.hash).toBe("#x");
  });

  it.each(["/history", "/template/4", "/print", "/templates"])(
    "leaves %s alone",
    (path) => {
      visit(path);
      startOnPrint();
      expect(window.location.pathname).toBe(path);
    },
  );
});

describe("AppRouter", () => {
  const mounted: string[] = [];

  function Page({ name }: { name: string }) {
    // Runs when the page is rendered into the document, which is what the
    // person would see flash.
    useEffect(() => {
      mounted.push(name);
    }, [name]);
    return <h1>{name}</h1>;
  }

  function App() {
    return (
      <AppRouter>
        <Link to="/">to designer</Link>
        <Routes>
          <Route path="/" element={<Page name="designer" />} />
          <Route path="/print" element={<Page name="print" />} />
        </Routes>
      </AppRouter>
    );
  }

  beforeEach(() => {
    mounted.length = 0;
  });

  it("opens on Print without ever rendering the Designer", () => {
    visit("/");
    render(<App />);
    expect(screen.getByRole("heading")).toHaveTextContent("print");
    expect(mounted).toEqual(["print"]);
  });

  it("keeps the Designer reachable afterwards", () => {
    visit("/");
    render(<App />);
    fireEvent.click(screen.getByRole("link", { name: "to designer" }));
    expect(screen.getByRole("heading")).toHaveTextContent("designer");
  });

  it("keeps a deep link", () => {
    visit("/");
    window.history.replaceState(null, "", "/print");
    render(<App />);
    expect(mounted).toEqual(["print"]);
  });
});
