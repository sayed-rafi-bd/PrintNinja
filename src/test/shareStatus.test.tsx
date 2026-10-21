import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { ServerUnreachableError, SessionExpiredError } from "@/lib/api/errors";
import { useShareStatus } from "@/lib/shell/useShareStatus";

const share = vi.hoisted(() => ({
  getServiceUrl: vi.fn(),
  getSessionToken: vi.fn(),
  fetchMe: vi.fn(),
  endSession: vi.fn(),
}));
vi.mock("@/lib/share/client", () => share);

function Probe() {
  const status = useShareStatus();
  return (
    <p data-testid="status">
      {status.state + ("handle" in status ? `:${status.handle}` : "")}
    </p>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  share.getServiceUrl.mockResolvedValue("https://srv.test");
  share.getSessionToken.mockResolvedValue("tok");
});

describe("useShareStatus", () => {
  it("is unconfigured with no server address", async () => {
    share.getServiceUrl.mockResolvedValue(null);
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("unconfigured"),
    );
  });

  it("is signed out with no token", async () => {
    share.getSessionToken.mockResolvedValue(null);
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("signed_out"),
    );
  });

  it("is online with the handle from /v2/auth/me", async () => {
    share.fetchMe.mockResolvedValue({ id: "u1", handle: "rafi" });
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("online:rafi"),
    );
  });

  it("returns to sign-in when the session expired", async () => {
    share.fetchMe.mockRejectedValue(new SessionExpiredError());
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("signed_out"),
    );
  });

  it("is offline when the server cannot be reached", async () => {
    share.fetchMe.mockRejectedValue(
      new ServerUnreachableError("https://srv.test"),
    );
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("offline"),
    );
  });
});
