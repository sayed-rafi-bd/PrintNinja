import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import axe from "axe-core";
import "@/lib/i18n";
import { AuthGate } from "@/components/AuthGate";
import { endSession, unpublishTemplate } from "@/lib/share/client";
import { checkSession, normalizeServiceUrl } from "@/lib/share/session";

const URL_KEY = "printninja-setting:share_service_url";
const TOKEN_KEY = "printninja-setting:share_session_token";
const SERVER = "http://server.test";

const tauriInvoke = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => tauriInvoke.fn(...a),
}));

type Handler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let handler: Handler;
let calls: Array<{ url: string; method: string }>;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  handler = () => json({ error: "unexpected request" }, 500);
  // The local agent: settings persist to the same localStorage keys the
  // client falls back to, and the template cache is empty unless a test
  // seeds it (offline start needs at least one cached template).
  tauriInvoke.fn.mockReset();
  tauriInvoke.fn.mockImplementation(
    async (cmd: string, args?: { key?: string; value?: string }) => {
      if (cmd === "list_templates") return [];
      if (cmd === "get_setting")
        return localStorage.getItem(`printninja-setting:${args?.key}`);
      if (cmd === "set_setting" && args?.key) {
        if (args.value) {
          localStorage.setItem(`printninja-setting:${args.key}`, args.value);
        } else {
          // The client clears by writing ""; the agent treats it as missing.
          localStorage.removeItem(`printninja-setting:${args.key}`);
        }
        return null;
      }
      return null;
    },
  );
  // openapi-fetch calls fetch with a single Request object, not
  // (url, init) — normalize so handlers keep seeing (url, init).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        input instanceof Request ? input : new Request(input as string, init);
      calls.push({ url: req.url, method: req.method });
      return handler(req.url, {
        ...init,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function signedInServer(): Handler {
  return (url) =>
    url.endsWith("/v2/auth/me")
      ? json({ id: "u1", handle: "sam" })
      : json({}, 404);
}

function renderGate() {
  return render(
    <AuthGate>
      <h1>The app</h1>
      <input aria-label="unsaved edit" />
    </AuthGate>,
  );
}

function fillSignIn(
  opts: { url?: string; handle?: string; password?: string } = {},
) {
  const { url = SERVER, handle = "sam", password = "correct horse" } = opts;
  fireEvent.change(screen.getByLabelText("Server address"), {
    target: { value: url },
  });
  fireEvent.change(screen.getByLabelText("Handle"), {
    target: { value: handle },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
}

describe("normalizeServiceUrl", () => {
  it("accepts http and https addresses and drops trailing slashes", () => {
    expect(normalizeServiceUrl(" https://print.example.com/ ")).toBe(
      "https://print.example.com",
    );
    expect(normalizeServiceUrl("http://192.168.1.5:3001")).toBe(
      "http://192.168.1.5:3001",
    );
  });

  it("rejects anything else", () => {
    expect(normalizeServiceUrl("")).toBeNull();
    expect(normalizeServiceUrl("print.example.com")).toBeNull();
    expect(normalizeServiceUrl("ftp://print.example.com")).toBeNull();
    expect(normalizeServiceUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("checkSession", () => {
  it("is signed out with no address when nothing is configured", async () => {
    expect(await checkSession()).toEqual({ state: "signed_out", url: null });
    expect(calls).toEqual([]);
  });

  it("is signed in when the server accepts the stored session", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = signedInServer();
    expect(await checkSession()).toEqual({ state: "signed_in", handle: "sam" });
  });

  it("removes a stored session the server rejects", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "stale");
    handler = () => json({ error: "Invalid session" }, 401);
    expect(await checkSession()).toEqual({ state: "signed_out", url: SERVER });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("keeps the stored session when the server cannot be reached", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await checkSession()).toEqual({ state: "unreachable", url: SERVER });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
  });

  it("treats a server error as unreachable, not as signed out", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = () => json({ error: "boom" }, 503);
    expect(await checkSession()).toEqual({ state: "unreachable", url: SERVER });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
  });

  it("checks the server is up before asking for a password", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    handler = (url) =>
      url.endsWith("/health") ? new Response("ok") : json({}, 404);
    expect(await checkSession()).toEqual({ state: "signed_out", url: SERVER });
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/v2/health`]);
  });
});

describe("sign-in gate", () => {
  it("shows sign-in, not the app, when nothing is configured", async () => {
    renderGate();
    expect(
      await screen.findByRole("heading", { level: 1, name: /sign in to/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("The app")).toBeNull();
  });

  it("opens the app when the stored session is valid", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = signedInServer();
    renderGate();
    expect(await screen.findByText("The app")).toBeVisible();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("returns to sign-in at start when the server rejects the stored session", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "stale");
    handler = () => json({ error: "Invalid session" }, 401);
    renderGate();
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByText("The app")).toBeNull();
    expect(screen.getByLabelText("Server address")).toHaveValue(SERVER);
  });

  it("signs in, saves the address and session, and opens the app", async () => {
    handler = (url, init) =>
      url === `${SERVER}/v2/auth/login` && init?.method === "POST"
        ? json({ token: "fresh", user: { id: "u1", handle: "sam" } })
        : json({}, 404);
    renderGate();
    await screen.findByLabelText("Password");
    fillSignIn({ url: `${SERVER}/` });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("The app")).toBeVisible();
    expect(localStorage.getItem(URL_KEY)).toBe(SERVER);
    expect(localStorage.getItem(TOKEN_KEY)).toBe("fresh");
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/v2/auth/login`]);
  });

  it("shows the server's message when sign-in fails and stays closed", async () => {
    handler = () =>
      json(
        {
          error: {
            code: "invalid_credentials",
            message: "Invalid handle or password",
            request_id: "r1",
          },
        },
        401,
      );
    renderGate();
    await screen.findByLabelText("Password");
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid handle or password",
    );
    expect(screen.queryByText("The app")).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("says so, and stays on the form, when sign-in cannot reach the server", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    renderGate();
    await screen.findByLabelText("Password");
    fillSignIn();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Cannot reach the server at ${SERVER}`,
    );
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("rejects a server address without a scheme before sending anything", async () => {
    renderGate();
    await screen.findByLabelText("Password");
    fillSignIn({ url: "server.test" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /starting with http/i,
    );
    expect(calls).toEqual([]);
  });

  it("registers a new account with the same rules as the server", async () => {
    handler = (url) =>
      url === `${SERVER}/v2/auth/register`
        ? json({ token: "new", user: { id: "u2", handle: "newbie" } })
        : json({}, 404);
    renderGate();
    await screen.findByLabelText("Password");
    fireEvent.click(screen.getByRole("button", { name: /create an account/i }));

    fillSignIn({ handle: "bad handle!", password: "longenough" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /1 to 32 letters/i,
    );

    fillSignIn({ handle: "newbie", password: "short" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /at least 8 characters/i,
      ),
    );
    expect(calls).toEqual([]);

    fillSignIn({ handle: "newbie", password: "longenough" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The app")).toBeVisible();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("new");
  });
});

describe("cannot reach server screen", () => {
  beforeEach(() => {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
  });

  it("blocks the app, then recovers on Retry", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    renderGate();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Cannot reach the server",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(`Server address: ${SERVER}`)).toBeInTheDocument();
    expect(screen.queryByText("The app")).toBeNull();

    handler = signedInServer();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("The app")).toBeVisible();
  });

  it("stays blocked when Retry fails again", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    renderGate();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.length).toBe(2));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("The app")).toBeNull();
  });

  it("stays blocked offline without a stored session, even with cached templates", async () => {
    localStorage.removeItem(TOKEN_KEY);
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    tauriInvoke.fn.mockImplementation(
      async (cmd: string, args?: { key?: string }) => {
        if (cmd === "list_templates") return [{ id: 1, name: "Cached" }];
        if (cmd === "get_setting")
          return localStorage.getItem(`printninja-setting:${args?.key}`);
        return null;
      },
    );
    renderGate();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Cannot reach the server",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("The app")).toBeNull();
  });

  it("opens the app offline when the cache has templates", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    tauriInvoke.fn.mockImplementation(
      async (cmd: string, args?: { key?: string }) => {
        if (cmd === "list_templates") return [{ id: 1, name: "Cached" }];
        if (cmd === "get_setting")
          return localStorage.getItem(`printninja-setting:${args?.key}`);
        return null;
      },
    );
    renderGate();
    expect(await screen.findByText("The app")).toBeVisible();
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: "Cannot reach the server",
      }),
    ).toBeNull();
  });

  it("opens the app offline after a failed Retry with cached templates", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    renderGate();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Cannot reach the server",
      }),
    ).toBeInTheDocument();
    tauriInvoke.fn.mockImplementation(
      async (cmd: string, args?: { key?: string }) => {
        if (cmd === "list_templates") return [{ id: 1, name: "Cached" }];
        if (cmd === "get_setting")
          return localStorage.getItem(`printninja-setting:${args?.key}`);
        return null;
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("The app")).toBeVisible();
  });

  it("lets the person fix a wrong server address", async () => {
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    renderGate();
    fireEvent.click(
      await screen.findByRole("button", { name: "Change server address" }),
    );
    expect(await screen.findByLabelText("Server address")).toHaveValue(SERVER);
  });
});

describe("after sign-in", () => {
  async function openApp() {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = signedInServer();
    const view = renderGate();
    await screen.findByText("The app");
    return view;
  }

  it("keeps the app open when the server goes away", async () => {
    await openApp();
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText("The app")).toBeVisible();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("returns to sign-in on a 401 and keeps unsaved edits", async () => {
    await openApp();
    const field = screen.getByLabelText("unsaved edit");
    fireEvent.change(field, { target: { value: "half-typed label" } });

    handler = () => json({ error: "Invalid session" }, 401);
    await expect(unpublishTemplate("t1")).rejects.toThrow(/session has ended/i);

    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/session ended/i);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    // Hidden, not unmounted: the edit is still there.
    expect(
      screen.getByLabelText("unsaved edit", { selector: "input" }),
    ).not.toBeVisible();
    expect(screen.getByDisplayValue("half-typed label")).toBeInTheDocument();

    // Signing in again brings the same screen back.
    handler = () => json({ token: "again", user: { id: "u1", handle: "sam" } });
    fireEvent.change(screen.getByLabelText("Handle"), {
      target: { value: "sam" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByLabelText("unsaved edit")).toBeVisible(),
    );
    expect(screen.getByDisplayValue("half-typed label")).toBeVisible();
  });

  it("returns to sign-in after signing out, without the expiry notice", async () => {
    await openApp();
    await act(async () => {
      await endSession("signed_out");
    });
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("The app", { selector: "h1" })).not.toBeVisible();
  });

  it("does not treat a network failure on a request as the end of the session", async () => {
    await openApp();
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(unpublishTemplate("t1")).rejects.toThrow(
      /cannot reach the server/i,
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
    expect(screen.getByText("The app")).toBeVisible();
  });
});

describe("accessibility", () => {
  const rules = {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  };

  it("sign-in screen has no axe violations", async () => {
    const { container } = renderGate();
    await screen.findByLabelText("Password");
    const results = await axe.run(container, rules);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("cannot reach server screen has no axe violations", async () => {
    localStorage.setItem(URL_KEY, SERVER);
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    const { container } = renderGate();
    await screen.findByRole("button", { name: "Retry" });
    const results = await axe.run(container, rules);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("session-ended notice", () => {
  async function openApp() {
    localStorage.setItem(URL_KEY, SERVER);
    localStorage.setItem(TOKEN_KEY, "tok");
    handler = (url) =>
      url.endsWith("/v2/auth/me")
        ? json({ id: "u1", handle: "sam" })
        : json({}, 404);
    renderGate();
    await screen.findByText("The app");
  }

  it("survives duplicate session-ended broadcasts from stale in-flight requests", async () => {
    await openApp();
    await act(async () => {
      await endSession("expired");
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /session ended/i,
    );
    // A stale request 401s a moment later and broadcasts again; the
    // notice must not be downgraded.
    await act(async () => {
      await endSession("expired");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/session ended/i);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("an explicit sign-out shows a clean form", async () => {
    await openApp();
    await act(async () => {
      await endSession("signed_out");
    });
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
