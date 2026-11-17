import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReplayDownloadJson } from "../components/FindingDetails";
import { canonicalJson } from "../lib/canonicalJson";
import { ComparisonResultPage } from "../pages/ComparisonResultPage";
import {
  DEMO_JOB_ID,
  makeDifferenceFoundJob,
  makeQueuedJob,
  makeRunningJob,
} from "./fixtures";

function renderResultRoute(
  id = DEMO_JOB_ID,
  props?: { pollTimeoutMs?: number; backoffScheduleMs?: readonly number[] },
) {
  return render(
    <MemoryRouter initialEntries={[`/comparisons/${id}`]}>
      <Routes>
        <Route path="/" element={<div data-testid="home-route">Home</div>} />
        <Route
          path="/comparisons/:id"
          element={<ComparisonResultPage {...props} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ComparisonResultPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls queued -> running -> difference_found with backoff and stops on terminal state", async () => {
    vi.useFakeTimers();

    const queued = makeQueuedJob();
    const running = makeRunningJob();
    const done = makeDifferenceFoundJob();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(queued), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(running), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(done), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    // Initial immediate fetch -> queued
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Queued")).toBeInTheDocument();

    // First backoff step: 300ms -> running
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Running")).toBeInTheDocument();

    // Second backoff step: 500ms -> difference_found
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Difference Found")).toBeInTheDocument();
    expect(
      screen.getByText("Sale Badge Present in Before only"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Confirmed by Official Liquid v5.14.0"),
    ).toBeInTheDocument();

    // Verify polling stops completely after terminal status
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels pending poll timers and aborts in-flight fetch on unmount", async () => {
    vi.useFakeTimers();

    const signals: AbortSignal[] = [];
    const queued = makeQueuedJob();
    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(
        new Response(JSON.stringify(queued), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderResultRoute();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);

    unmount();
    expect(signals[0].aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders no_difference_found with required message and examined counts", async () => {
    const noDiffJob = {
      ...makeQueuedJob(),
      status: "no_difference_found" as const,
      stats: {
        search_pairs: 16,
        shrink_pairs: 0,
        parity_rejections: 0,
        exhausted_by: "pair_limit" as const,
        first_difference_ms: null,
        elapsed_ms: 215,
      },
      completed_at: "2026-11-17T10:00:01.000Z",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(noDiffJob), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    expect(
      await screen.findByText("no difference found within this search"),
    ).toBeInTheDocument();
    expect(screen.getByText("No Difference Found")).toBeInTheDocument();
    expect(screen.getByText("16")).toBeInTheDocument();
    expect(screen.getByText("pair_limit")).toBeInTheDocument();
    expect(screen.getByText("215 ms")).toBeInTheDocument();
  });

  it("renders failed state with diagnostic code, message, span highlight, and partial stats", async () => {
    const failedJob = {
      ...makeQueuedJob(),
      status: "failed" as const,
      request: {
        ...makeQueuedJob().request,
        before: { source: "<div>\n{% bogus %}\n</div>" },
      },
      stats: {
        search_pairs: 1,
        shrink_pairs: 0,
        parity_rejections: 0,
        exhausted_by: null,
        first_difference_ms: null,
        elapsed_ms: 14,
      },
      error: {
        code: "unsupported_feature",
        message: "Unsupported Liquid tag '{% bogus %}'",
        span: { start_byte: 6, end_byte: 17, line: 2, column: 1 },
      },
      completed_at: "2026-11-17T10:00:01.000Z",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(failedJob), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    expect(await screen.findByText("Comparison Failed")).toBeInTheDocument();
    expect(screen.getAllByText("unsupported_feature").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Unsupported Liquid tag '\{% bogus %\}'/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Line 2, Column 1/)).toBeInTheDocument();
    expect(screen.getAllByText("Span L2").length).toBeGreaterThan(0);
    expect(screen.getByText("14 ms")).toBeInTheDocument();
  });

  it("renders actionable 404 view and stops polling", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "not_found",
            message: `Comparison '${DEMO_JOB_ID}' was not found`,
            span: null,
          },
        }),
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Comparison Not Found")).toBeInTheDocument();
    expect(screen.getByText("Not Found (404)")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Submit New Comparison" }),
    ).toHaveAttribute("href", "/");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles polling timeout with Retry action that resumes and completes", async () => {
    vi.useFakeTimers();

    const queued = makeQueuedJob();
    const done = makeDifferenceFoundJob();
    let callCount = 0;

    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      const body = callCount <= 3 ? queued : done;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute(DEMO_JOB_ID, {
      pollTimeoutMs: 1000,
      backoffScheduleMs: [300, 500, 800],
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Queued")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1050);
    });

    expect(screen.getByText("Polling Timed Out")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "Retry Polling" });

    fireEvent.click(retryButton);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Difference Found")).toBeInTheDocument();
  });

  it("reconstructs full finding view on direct reload, escapes XSS, highlights anchors, and serializes canonical replay JSON", async () => {
    const xssPayload =
      '<script>window.__xss = 1;</script><img src=x onerror="window.__xss=2"><span data-regression-badge="sale">Sale</span>';
    const job = makeDifferenceFoundJob();
    job.finding!.before.html = xssPayload;
    job.finding!.reference.before.html = xssPayload;

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(job), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    expect(await screen.findByText("Structural Change")).toBeInTheDocument();
    expect(screen.getByText("Before Line L3 (seq #13)")).toBeInTheDocument();
    expect(screen.getByText("After Line L1 (seq #5)")).toBeInTheDocument();

    // Variant table + derived product projection
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("product.compare_at_price_varies")).toBeInTheDocument();

    // Highlighted anchor lines with explicit Anchor marker
    const beforeLinesEl = screen.getByTestId("before-source-lines");
    const afterLinesEl = screen.getByTestId("after-source-lines");
    expect(
      beforeLinesEl.querySelector('[data-anchor-line="true"]'),
    ).toHaveTextContent("Anchor");
    expect(
      afterLinesEl.querySelector('[data-anchor-line="true"]'),
    ).toHaveTextContent("Anchor");

    // Loop variant_id and typed operands in trace section
    expect(screen.getAllByText(/variant_id="v2"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("boolean").length).toBeGreaterThan(0);
    expect(screen.getAllByText("number").length).toBeGreaterThan(0);

    // Expandable full trace <details>
    expect(
      screen.getByText("Before Full Trace Events (7 events)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("After Full Trace Events (3 events)"),
    ).toBeInTheDocument();

    // XSS payload must appear strictly as text inside <code> without creating <script> or <img> nodes
    const htmlOutputContainer = screen.getByTestId("before-rendered-html");
    expect(htmlOutputContainer.textContent).toBe(xssPayload);
    expect(htmlOutputContainer.querySelector("script")).toBeNull();
    expect(htmlOutputContainer.querySelector("img")).toBeNull();

    // Replay CLI command & canonical sorted-key download payload
    expect(
      screen.getByText("python3.11 -m search replay --bundle replay.json"),
    ).toBeInTheDocument();

    const replayPayload = buildReplayDownloadJson(job);
    expect(replayPayload).toBe(canonicalJson(job.finding!.replay));
    expect(replayPayload.indexOf('"after_sha256"')).toBeLessThan(
      replayPayload.indexOf('"before_sha256"'),
    );

    const origCreateObjectUrl = URL.createObjectURL;
    const origRevokeObjectUrl = URL.revokeObjectURL;
    const createObjectUrlMock = vi.fn().mockReturnValue("blob:mock-replay");
    const revokeObjectUrlMock = vi.fn();
    URL.createObjectURL = createObjectUrlMock;
    URL.revokeObjectURL = revokeObjectUrlMock;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Download Replay JSON" }),
      );
      expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
      const passedBlob = createObjectUrlMock.mock.calls[0][0] as Blob;
      expect(passedBlob.size).toBe(
        new TextEncoder().encode(replayPayload).length,
      );
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = origCreateObjectUrl;
      URL.revokeObjectURL = origRevokeObjectUrl;
    }
  });

  it("caps polling backoff at 2000ms after 300, 500, 800, 1200, 2000ms steps", async () => {
    vi.useFakeTimers();

    const queued = makeQueuedJob();
    const done = makeDifferenceFoundJob();
    let calls = 0;

    const fetchMock = vi.fn().mockImplementation(() => {
      calls += 1;
      const payload = calls >= 8 ? done : queued;
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderResultRoute();

    // Call 1 at t=0
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expectedDelays = [300, 500, 800, 1200, 2000, 2000, 2000];
    for (let i = 0; i < expectedDelays.length; i++) {
      const delay = expectedDelays[i];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(i + 2);
    }

    expect(screen.getByText("Difference Found")).toBeInTheDocument();
  });
});
