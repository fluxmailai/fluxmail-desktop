/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Splash } from "../src/renderer/App";

describe("startup error state", () => {
  it("explains the error and restarts the full app", () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: { system: { restart } },
    });

    render(
      <Splash
        error={{
          code: "desktop_error",
          message: "Fluxmail could not open your mail.",
          retryable: true,
        }}
        updateReady={false}
        onInstallUpdate={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "An error occurred" })).toBeTruthy();
    expect(screen.getByText("Fluxmail could not open your mail.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart Fluxmail" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("asks for an update when the shared store is newer", () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "fluxmail", {
      configurable: true,
      value: { system: { restart } },
    });

    render(
      <Splash
        error={{
          code: "incompatible_store",
          message: "Update Fluxmail Desktop to continue. Your data was not changed.",
          retryable: false,
        }}
        updateReady={false}
        onInstallUpdate={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Update Fluxmail to continue" })).toBeTruthy();
    expect(screen.getByText(/Your data was not changed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(restart).toHaveBeenCalledOnce();
  });
});
