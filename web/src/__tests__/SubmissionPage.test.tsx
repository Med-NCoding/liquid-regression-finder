import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_AFTER_SOURCE, DEMO_BEFORE_SOURCE } from "../lib/demoSnippets";
import { SubmissionPage } from "../pages/SubmissionPage";
import { DEMO_JOB_ID, makeQueuedJob } from "./fixtures";

describe("SubmissionPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads demo snippets, submits POST /api/v1/comparisons, and navigates on 202", async () => {
    const queued = makeQueuedJob();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(queued), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SubmissionPage />} />
          <Route
            path="/comparisons/:id"
            element={<div data-testid="result-route">Loaded comparison</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load Demo Snippets" }));

    const beforeInput = screen.getByLabelText("Before Liquid Snippet") as HTMLTextAreaElement;
    const afterInput = screen.getByLabelText("After Liquid Snippet") as HTMLTextAreaElement;
    expect(beforeInput.value).toBe(DEMO_BEFORE_SOURCE);
    expect(afterInput.value).toBe(DEMO_AFTER_SOURCE);

    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Search Pairs"), { target: { value: "512" } });
    fireEvent.change(screen.getByLabelText("Shrink Pairs"), { target: { value: "64" } });
    fireEvent.change(screen.getByLabelText("Idempotency Key (Optional)"), {
      target: { value: "pr-99-test" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Run Comparison" }));

    await waitFor(() => {
      expect(screen.getByTestId("result-route")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/comparisons");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("pr-99-test");
    expect(JSON.parse(String(init.body))).toEqual({
      schema_version: 1,
      before: { source: DEMO_BEFORE_SOURCE },
      after: { source: DEMO_AFTER_SOURCE },
      observer: "sale_badge",
      seed: 7,
      budget: { search_pairs: 512, shrink_pairs: 64 },
    });
    expect(DEMO_JOB_ID).toBe(queued.id);
  });

  it("displays structured 422 validation errors without clearing form state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "snippet_too_large",
            message: "CompareRequest.before.source (16385 bytes) exceeds 16384 byte limit",
            span: null,
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SubmissionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const beforeInput = screen.getByLabelText("Before Liquid Snippet") as HTMLTextAreaElement;
    const afterInput = screen.getByLabelText("After Liquid Snippet") as HTMLTextAreaElement;
    fireEvent.change(beforeInput, { target: { value: "{% if product.available %}Sale{% endif %}" } });
    fireEvent.change(afterInput, { target: { value: "<span>plain</span>" } });
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "42" } });

    fireEvent.click(screen.getByRole("button", { name: "Run Comparison" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 422");
    expect(alert).toHaveTextContent("snippet_too_large");
    expect(alert).toHaveTextContent("exceeds 16384 byte limit");

    expect(beforeInput.value).toBe("{% if product.available %}Sale{% endif %}");
    expect(afterInput.value).toBe("<span>plain</span>");
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("42");
  });

  it("displays 409 idempotency conflict errors without clearing form state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "idempotency_conflict",
            message: "Idempotency-Key was already used with a different comparison request",
            span: null,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<SubmissionPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const beforeInput = screen.getByLabelText("Before Liquid Snippet") as HTMLTextAreaElement;
    const keyInput = screen.getByLabelText("Idempotency Key (Optional)") as HTMLInputElement;
    fireEvent.change(beforeInput, { target: { value: "<span>a</span>" } });
    fireEvent.change(keyInput, { target: { value: "dup-key" } });

    fireEvent.click(screen.getByRole("button", { name: "Run Comparison" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 409");
    expect(alert).toHaveTextContent("idempotency_conflict");
    expect(beforeInput.value).toBe("<span>a</span>");
    expect(keyInput.value).toBe("dup-key");
  });
});
