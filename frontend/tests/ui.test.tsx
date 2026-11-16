// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, Empty, Issue, Table } from "@/components/ui";

afterEach(cleanup);

describe("accessible console primitives", () => {
  it("assigns a meaning and a label to empty and failure states", () => {
    const retry = vi.fn();
    render(<><Empty title="No requests" description="Choose another date range." />
      <Issue message="Gateway unreachable" retry={retry} /><Badge tone="good" dot>Operational</Badge></>);
    expect(screen.getByText("No requests")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Gateway unreachable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("Operational").textContent).toBe("Operational");
  });
  it("labels the horizontally scrollable table for keyboard users", () => {
    render(<Table label="Model aliases" headers={["Alias"]}><tr><td>mock-chat</td></tr></Table>);
    expect(screen.getByRole("region", { name: "Model aliases table" }).tabIndex).toBe(0);
    expect(screen.getByRole("columnheader", { name: "Alias" })).toBeTruthy();
  });
});
