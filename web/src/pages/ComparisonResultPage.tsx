import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FindingDetails } from "../components/FindingDetails";
import { StatusPanel } from "../components/StatusPanel";
import {
  ApiClientError,
  DEFAULT_POLL_TIMEOUT_MS,
  POLL_BACKOFF_MS,
  fetchComparison,
} from "../lib/api";
import type { ComparisonJob, Diagnostic } from "../types";

export interface ComparisonResultPageProps {
  pollTimeoutMs?: number;
  backoffScheduleMs?: readonly number[];
}

export function ComparisonResultPage({
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  backoffScheduleMs = POLL_BACKOFF_MS,
}: ComparisonResultPageProps) {
  const { id = "" } = useParams<{ id: string }>();

  const [job, setJob] = useState<ComparisonJob | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFoundError, setNotFoundError] = useState<Diagnostic | null>(null);
  const [requestError, setRequestError] = useState<{
    statusCode: number;
    diagnostic: Diagnostic;
  } | null>(null);
  const [timedOut, setTimedOut] = useState<boolean>(false);
  const [pollAttempt, setPollAttempt] = useState<number>(0);
  const [retryNonce, setRetryNonce] = useState<number>(0);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      setNotFoundError({
        code: "not_found",
        message: "Comparison ID is missing from URL.",
        span: null,
      });
      return;
    }

    let cancelled = false;
    let pollTimerId: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimerId: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;
    let backoffIndex = 0;

    setLoading(true);
    setNotFoundError(null);
    setRequestError(null);
    setTimedOut(false);
    setPollAttempt(0);

    const clearAllTimers = () => {
      if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
      if (timeoutTimerId !== null) {
        clearTimeout(timeoutTimerId);
        timeoutTimerId = null;
      }
    };

    timeoutTimerId = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }
      activeController?.abort();
      setLoading(false);
      setTimedOut(true);
    }, pollTimeoutMs);

    const executePoll = async () => {
      if (cancelled) return;

      const controller = new AbortController();
      activeController = controller;

      try {
        const fetchedJob = await fetchComparison(id, controller.signal);
        if (cancelled) return;

        setJob(fetchedJob);
        setLoading(false);
        setNotFoundError(null);
        setRequestError(null);
        setPollAttempt((prev) => prev + 1);

        if (fetchedJob.status === "queued" || fetchedJob.status === "running") {
          const schedule =
            backoffScheduleMs.length > 0 ? backoffScheduleMs : POLL_BACKOFF_MS;
          const delayMs = schedule[Math.min(backoffIndex, schedule.length - 1)];
          backoffIndex += 1;

          pollTimerId = setTimeout(() => {
            void executePoll();
          }, delayMs);
        } else {
          clearAllTimers();
        }
      } catch (err) {
        if (
          cancelled ||
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }

        clearAllTimers();
        setLoading(false);

        if (err instanceof ApiClientError && err.statusCode === 404) {
          setNotFoundError(err.diagnostic);
          return;
        }

        if (err instanceof ApiClientError) {
          setRequestError({
            statusCode: err.statusCode,
            diagnostic: err.diagnostic,
          });
          return;
        }

        setRequestError({
          statusCode: 0,
          diagnostic: {
            code: "network_error",
            message:
              err instanceof Error ? err.message : "Network request failed",
            span: null,
          },
        });
      }
    };

    void executePoll();

    return () => {
      cancelled = true;
      clearAllTimers();
      activeController?.abort();
    };
  }, [id, pollTimeoutMs, backoffScheduleMs, retryNonce]);

  const handleRetry = () => {
    setRetryNonce((n) => n + 1);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Comparison Result</h1>
          <p className="subtitle mono">{id}</p>
        </div>
        <Link to="/" className="btn">
          New Comparison
        </Link>
      </div>

      <StatusPanel
        jobId={id}
        job={job}
        loading={loading}
        notFoundError={notFoundError}
        requestError={requestError}
        timedOut={timedOut}
        pollAttempt={pollAttempt}
        onRetry={handleRetry}
      />

      {!notFoundError && !requestError && !timedOut && job?.status === "difference_found" && (
        <FindingDetails job={job} />
      )}
    </div>
  );
}
