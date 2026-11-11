import { useEffect, useRef } from "react";
import { useSessionStore, setTopicsData } from "@renderer/stores/session";
import * as api from "@renderer/services/api";

/**
 * Drives the session lifecycle when a bag path is provided.
 * - Creates the backend session.
 * - Polls until status === 'ready'.
 * - Fetches all tab data in parallel once ready.
 *
 * Guard: if the store already has a ready session for the same path,
 * this hook is a no-op (handles navigate-away-and-back without refetch).
 */
export function useSession(pendingPath: string | null): void {
  const { pendingSessionId, setSession, setStatus, setTabData, clearSession } =
    useSessionStore();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pendingPath && !pendingSessionId) return;

    // No-op if the store already holds this bag or session, ready. The guard
    // reads the store, not this hook's refs, because the Copilot remounts
    // after every screen switch: loading again would create a new session and
    // clear its chat, including an answer still streaming.
    const loaded = useSessionStore.getState();
    if (
      loaded.status === "ready" &&
      (pendingPath
        ? loaded.loadedPath === pendingPath
        : loaded.sessionId === pendingSessionId)
    )
      return;

    clearSession();
    useSessionStore.setState({ loadedPath: pendingPath });
    setStatus(pendingPath ? "creating" : "processing");

    let cancelled = false;

    const start = async () => {
      try {
        let session_id = pendingSessionId;

        if (!session_id && pendingPath) {
          const res = await api.createSession(pendingPath);
          session_id = res.session_id;
        }

        if (!session_id) return;
        if (cancelled) return;

        const meta = await api.getSession(session_id);
        if (cancelled) return;
        setSession(session_id, meta);
        setStatus(meta.status);

        // Poll until ready
        const poll = async () => {
          if (cancelled) return;
          try {
            const updated = await api.getSession(session_id!);
            if (cancelled) return;

            if (updated.status === "ready") {
              setSession(session_id!, updated);
              setStatus("ready");

              // Fetch all tab data in parallel
              const [timeline, topics, logs, kgraph] = await Promise.allSettled(
                [
                  api.getTimeline(session_id!),
                  api.getTopics(session_id!),
                  api.getLogs(session_id!),
                  api.getKGraph(session_id!),
                ],
              );

              if (cancelled) return;

              if (timeline.status === "fulfilled")
                setTabData("timeline", timeline.value);
              if (topics.status === "fulfilled") setTopicsData(topics.value);
              if (logs.status === "fulfilled") setTabData("logs", logs.value);
              if (kgraph.status === "fulfilled")
                setTabData("kgraph", kgraph.value);
            } else if (updated.status === "error") {
              setStatus("error");
            } else {
              timeoutRef.current = setTimeout(() => {
                void poll();
              }, 1500);
            }
          } catch {
            if (!cancelled) setStatus("error");
          }
        };

        void poll();
      } catch {
        if (!cancelled) setStatus("error");
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [pendingPath, pendingSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
}
