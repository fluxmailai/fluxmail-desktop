/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/renderer/components/Sidebar";
import type { UpdateStatus } from "../src/shared/contracts";

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(cleanup);

function renderSidebar(updateStatus: UpdateStatus) {
  const onInstallUpdate = vi.fn();
  render(
    <Sidebar
      accounts={[]}
      folders={[]}
      activeView="inbox"
      unreadCount={0}
      draftCount={0}
      scheduledCount={0}
      collapsed={false}
      updateStatus={updateStatus}
      onAccountChange={vi.fn()}
      onViewChange={vi.fn()}
      onCompose={vi.fn()}
      onSettings={vi.fn()}
      onInstallUpdate={onInstallUpdate}
      onToggleCollapsed={vi.fn()}
    />,
  );
  return { onInstallUpdate };
}

describe("Sidebar update notice", () => {
  it.each([
    { state: "idle" },
    { state: "checking" },
    { state: "current" },
    { state: "failed", stage: "check" },
  ] as const)("stays hidden when the update status is %o", (status) => {
    renderSidebar(status);

    expect(screen.queryByText("Downloading update")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
  });

  it("shows a download in progress without offering to restart", () => {
    renderSidebar({ state: "downloading" });

    expect(screen.getByRole("status")).toHaveTextContent("Downloading update");
    expect(screen.queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
  });

  it("installs a downloaded update when clicked", () => {
    const { onInstallUpdate } = renderSidebar({ state: "ready", version: "0.11.0" });

    const button = screen.getByRole("button", { name: "Restart to update" });
    expect(button).toHaveAttribute("title", "Fluxmail 0.11.0 is ready to install");
    fireEvent.click(button);

    expect(onInstallUpdate).toHaveBeenCalledOnce();
  });
});
