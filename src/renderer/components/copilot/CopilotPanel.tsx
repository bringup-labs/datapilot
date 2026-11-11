import { useEffect, useRef, useState, type JSX } from "react";
import { Icon } from "@renderer/components/Icon";
import { useChatStore } from "@renderer/stores/chat";
import { useSessionStore } from "@renderer/stores/session";
import { ChatMessage } from "./ChatMessage";
import { ContextChips } from "./ContextChips";
import { CommandBar } from "./CommandBar";
import { ConnectBanner } from "./ConnectBanner";
import { EngineMenu } from "./EngineMenu";
import * as api from "@renderer/services/api";
import { messageFromHistoryRow } from "@renderer/lib/chatMapping";
import type { SessionMeta } from "@shared/types";

function parseUTCDate(dateStr: string): Date {
  if (!dateStr.endsWith("Z") && !dateStr.includes("+") && !/-\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr + "Z");
  }
  return new Date(dateStr);
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  const date = parseUTCDate(dateStr);
  if (isNaN(date.getTime())) return "";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diffMs = date.getTime() - Date.now();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  const absMs = Math.abs(diffMs);
  if (absMs < 60000) {
    return "just now";
  } else if (absMs < 3600000) {
    return rtf.format(diffMins, "minute");
  } else if (absMs < 86400000) {
    return rtf.format(diffHours, "hour");
  } else {
    return rtf.format(diffDays, "day");
  }
}

export function CopilotPanel(): JSX.Element {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setMessages = useChatStore((s) => s.setMessages);
  const showSession = useChatStore((s) => s.showSession);
  const {
    status,
    sessionId,
    clearSession,
    setPendingPath,
    pendingPath,
    setPendingSessionId,
  } = useSessionStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track the session ID that was resumed from history so we can reload its
  // chat messages once the session is fully loaded.
  const resumingSessionId = useRef<string | null>(null);

  const [indexingProgress, setIndexingProgress] = useState(0);

  useEffect(() => {
    if (status === "creating" || status === "processing") {
      setIndexingProgress(5);
      const interval = setInterval(() => {
        setIndexingProgress((prev) => {
          if (prev >= 95) return prev;
          const step = prev < 50 ? 5 : prev < 80 ? 2 : 1;
          return prev + step;
        });
      }, 600);
      return () => clearInterval(interval);
    } else if (status === "ready") {
      setIndexingProgress(100);
    } else {
      setIndexingProgress(0);
    }
  }, [status]);

  const getIndexingStepText = (pct: number): string => {
    if (pct < 25) return "Reading ROS bag telemetry...";
    if (pct < 50) return "Extracting topics and transform frames...";
    if (pct < 70) return "Evaluating causal relationships...";
    if (pct < 90) return "Generating log embeddings...";
    return "Building knowledge graph...";
  };

  // Clear the chat when the session changes, but not when this panel remounts
  // after a screen switch: the chat, and an answer still streaming, stay. An
  // answer for the old bag stops streaming here and saves to its own bag.
  useEffect(() => {
    showSession(sessionId);
  }, [sessionId, showSession]);

  // After a session resumed from history is ready, load its chat history.
  useEffect(() => {
    if (
      sessionId &&
      status === "ready" &&
      resumingSessionId.current === sessionId
    ) {
      resumingSessionId.current = null;
      api.getChatMessages(sessionId).then((rows) => {
        if (rows.length === 0) return;
        const loaded = rows.map((r, i) => ({
          ...messageFromHistoryRow(r, i),
          time: r.created_at
            ? parseUTCDate(r.created_at).toLocaleTimeString()
            : undefined,
        }));
        setMessages(loaded);
      }).catch(() => {/* silently ignore if history unavailable */});
    }
  }, [sessionId, status, setMessages]);

  /**
   * "New session" — clears the chat AND resets the session entirely so the
   * user lands on the idle workspace ready to load a fresh bag.
   * This also aborts any in-flight session creation (via the useSession
   * cleanup that fires when pendingPath becomes null).
   */
  const handleNewSession = () => {
    clearMessages();
    clearSession();
    setPendingPath(null);
  };

  const [showHistory, setShowHistory] = useState(false);
  const [historySessions, setHistorySessions] = useState<SessionMeta[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  const handleToggleHistory = async () => {
    const nextVal = !showHistory;
    setShowHistory(nextVal);
    if (nextVal) {
      setLoadingHistory(true);
      try {
        const data = await api.getSessions();
        setHistorySessions(data);
      } catch (err) {
        console.error("Failed to load sessions history:", err);
      } finally {
        setLoadingHistory(false);
      }
    }
  };

  // Auto-scroll to bottom on new messages and on every streamed update.
  // The store replaces the `messages` array on each streamed update, so
  // depending on `messages` (not just its length) follows token streaming too.
  // Only stick to the bottom when the user is already near it — if they've
  // scrolled up to read earlier messages, don't yank them back down.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming]);

  const totalIn = messages.reduce(
    (acc, m) => acc + (m.usage?.tokens_in || 0),
    0,
  );
  const totalOut = messages.reduce(
    (acc, m) => acc + (m.usage?.tokens_out || 0),
    0,
  );
  const totalTokens = totalIn + totalOut;
  const totalCost = messages.reduce(
    (acc, m) => acc + (m.usage?.est_cost_usd || 0),
    0,
  );

  return (
    <div
      className="col"
      style={{
        width: 420,
        flexShrink: 0,
        background: "var(--color-bg-1)",
        borderRight: "1px solid var(--color-border-1)",
        minHeight: 0,
      }}
    >
      {/* Panel header */}
      <div
        className="row"
        style={{
          height: 44,
          padding: "0 14px",
          borderBottom: "1px solid var(--color-border-1)",
          gap: 10,
          flexShrink: 0,
          position: "relative",
        }}
      >
        <Icon.Sparkles size={15} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-0)",
          }}
        >
          Copilot
        </span>
        <EngineMenu />
        {totalTokens > 0 && (
          <span
            className="pill sm ghost mono"
            style={{
              fontSize: 10,
              gap: 4,
              display: "flex",
              alignItems: "center",
              cursor: "help",
            }}
            title={`Session usage:\n- Input: ${totalIn.toLocaleString()} tokens\n- Output: ${totalOut.toLocaleString()} tokens\n- Est. Cost: $${totalCost.toFixed(4)}`}
          >
            <Icon.Activity size={10} />
            <span>{(totalTokens / 1000).toFixed(1)}k tokens</span>
          </span>
        )}
        <div className="flex1" />
        <button
          className="btn ghost icon sm"
          title="New session"
          onClick={handleNewSession}
        >
          <Icon.Plus size={13} />
        </button>
        <button
          className={`btn ghost icon sm ${showHistory ? "primary" : ""}`}
          title="History"
          onClick={handleToggleHistory}
        >
          <Icon.Clock size={13} />
        </button>

        {showHistory && (
          <>
            {/* Invisible backdrop to close modal on outside click */}
            <div
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 99,
              }}
              onClick={() => setShowHistory(false)}
            />
            <div
              className="card"
              style={{
                position: "absolute",
                top: 40,
                right: 14,
              width: 320,
              maxHeight: 300,
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              boxShadow: "var(--shadow-lg)",
              background: "var(--color-bg-2)",
              borderColor: "var(--color-border-2)",
              overflow: "hidden",
            }}
          >
            <div
              className="row"
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid var(--color-border-1)",
                justifyContent: "space-between",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "var(--color-text-0)",
                }}
              >
                Session History
              </span>
              <div className="row gap-1">
                {historySessions.length > 0 && (
                  <button
                    className="btn ghost sm"
                    style={{ height: 20, fontSize: 10.5, color: "var(--color-danger)" }}
                    disabled={clearingHistory}
                    onClick={async () => {
                      if (confirm("Delete all sessions? This cannot be undone.")) {
                        setClearingHistory(true);
                        try {
                          await api.clearAllSessions();
                          setHistorySessions([]);
                          clearSession();
                        } catch {
                          alert("Failed to clear all sessions");
                        } finally {
                          setClearingHistory(false);
                        }
                      }
                    }}
                  >
                    {clearingHistory ? "Clearing..." : "Clear all"}
                  </button>
                )}
                <button
                  className="btn ghost icon sm"
                  style={{ height: 20, width: 20 }}
                  onClick={() => setShowHistory(false)}
                  disabled={clearingHistory}
                >
                  <Icon.Check size={12} style={{ color: "var(--color-ok)" }} />
                </button>
              </div>
            </div>
            <div style={{ overflowY: "auto", flex: 1, padding: 4 }}>
              {clearingHistory ? (
                <div
                  style={{
                    padding: 20,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--color-text-3)",
                  }}
                >
                  <span className="pulse">Clearing all sessions...</span>
                </div>
              ) : loadingHistory ? (
                <div
                  style={{
                    padding: 20,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--color-text-3)",
                  }}
                >
                  <span className="pulse">Loading history...</span>
                </div>
              ) : historySessions.length === 0 ? (
                <div
                  style={{
                    padding: 20,
                    textAlign: "center",
                    fontSize: 12,
                    color: "var(--color-text-3)",
                  }}
                >
                  No past sessions found.
                </div>
              ) : (
                historySessions.map((s) => (
                  <div
                    key={s.id}
                    className="row gap-2"
                    style={{
                      padding: "8px 10px",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 12,
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--color-bg-3)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div
                      className="col flex1"
                      style={{ minWidth: 0 }}
                      onClick={() => {
                        resumingSessionId.current = s.id;
                        setPendingSessionId(s.id);
                        setShowHistory(false);
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 500,
                          color: "var(--color-text-1)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={s.filename}
                      >
                        {s.filename}
                      </div>
                      <div
                        className="dim"
                        style={{ fontSize: 10.5, marginTop: 2 }}
                      >
                        {s.robot} · {s.durationSeconds.toFixed(1)}s · {s.status}
                        {s.updatedAt && ` · ${formatRelativeTime(s.updatedAt)}`}
                      </div>
                    </div>
                    <button
                      className="btn ghost icon sm"
                      style={{
                        height: 24,
                        width: 24,
                        color: "var(--color-danger)",
                      }}
                      title="Delete session"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (confirm(`Delete session for ${s.filename}?`)) {
                          try {
                            await api.deleteSession(s.id);
                            setHistorySessions((prev) =>
                              prev.filter((item) => item.id !== s.id),
                            );
                          } catch (err) {
                            alert("Failed to delete session");
                          }
                        }
                      }}
                    >
                      <Icon.Trash size={11} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          </>
        )}
      </div>

      <ConnectBanner />

      {/* Context chips */}
      <ContextChips />

      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex1 no-scrollbar"
        style={{ overflowY: "auto", padding: "8px 0" }}
      >
        {messages.length === 0 && status !== "idle" && (
          <div
            className="col"
            style={{
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: 8,
              padding: "24px 20px",
            }}
          >
            {status === "creating" || status === "processing" ? (
              <div
                className="col gap-3"
                style={{
                  width: "100%",
                  padding: "0 20px",
                  alignItems: "center",
                }}
              >
                {/* AI / Sparkles Pulsing Icon */}
                <div
                  className="row"
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "var(--color-bg-2)",
                    border: "1px solid var(--color-border-1)",
                    display: "grid",
                    placeItems: "center",
                    boxShadow: "var(--shadow-sm)",
                    color: "var(--color-accent)",
                    animation: "pulse 2s infinite ease-in-out",
                  }}
                >
                  <Icon.Sparkles
                    size={20}
                    style={{ animation: "spin 3s linear infinite" }}
                  />
                </div>

                {/* Status label */}
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--color-text-1)",
                    textAlign: "center",
                  }}
                >
                  {status === "creating"
                    ? "Creating session..."
                    : getIndexingStepText(indexingProgress)}
                </span>

                {/* Progress bar container */}
                <div
                  style={{
                    width: "100%",
                    height: 6,
                    background: "var(--color-bg-3)",
                    borderRadius: 3,
                    overflow: "hidden",
                    border: "1px solid var(--color-border-1)",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      width: `${indexingProgress}%`,
                      height: "100%",
                      background:
                        "linear-gradient(90deg, var(--color-accent) 0%, oklch(0.68 0.15 280) 100%)",
                      borderRadius: 3,
                      boxShadow: "0 0 8px var(--color-accent)",
                      transition: "width 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                  />
                </div>

                {/* Progress metadata */}
                <div
                  className="row"
                  style={{
                    justifyContent: "space-between",
                    width: "100%",
                    fontSize: 10.5,
                    color: "var(--color-text-3)",
                    padding: "0 2px",
                  }}
                >
                  <span>AI Ingestion</span>
                  <span className="mono" style={{ fontWeight: 600, color: "var(--color-accent)" }}>
                    {indexingProgress}%
                  </span>
                </div>
              </div>
            ) : status === "error" ? (
              <div className="col gap-3 items-center justify-center">
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--color-danger)",
                    textAlign: "center",
                  }}
                >
                  Failed to load session. Please try again.
                </span>
                <button
                  className="btn primary sm"
                  onClick={() => {
                    const path = pendingPath;
                    if (path) {
                      setPendingPath(null);
                      setTimeout(() => {
                        setPendingPath(path);
                      }, 50);
                    }
                  }}
                  title="Retry loading session"
                >
                  <Icon.Refresh size={12} />
                  Retry Loading
                </button>
              </div>
            ) : (
              <span
                style={{
                  fontSize: 12,
                  color: "var(--color-text-3)",
                  textAlign: "center",
                }}
              >
                Session ready. Ask anything about this run.
              </span>
            )}
          </div>
        )}
        {messages.length === 0 && status === "idle" && (
          <div
            style={{
              padding: "32px 20px",
              textAlign: "center",
              color: "var(--color-text-3)",
              fontSize: 12,
            }}
          >
            Load a ROS bag to begin analysis.
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} msg={msg} />
        ))}
      </div>

      {/* Quick-action chips */}
      <div style={{ padding: "8px 14px 4px", flexShrink: 0 }}>
        <div className="row gap-2" style={{ flexWrap: "wrap" }}>
          <button
            className="pill ghost"
            style={{ cursor: "pointer", height: 24 }}
            onClick={async () => {
              if (window.datapilot?.file?.pickBag) {
                try {
                  const filepath = await window.datapilot.file.pickBag();
                  if (filepath) {
                    setPendingPath(filepath);
                  }
                } catch (err: any) {
                  alert(`Failed to pick file: ${err.message || err}`);
                }
              } else {
                alert("File picker is not available in this environment.");
              }
            }}
          >
            <Icon.Upload size={11} /> Upload rosbag
          </button>
          <button
            className="pill ghost"
            style={{ height: 24 }}
            disabled
            title="Coming soon"
          >
            <Icon.Wifi size={11} /> Connect live robot
          </button>
          <button
            className="pill ghost"
            style={{ height: 24 }}
            disabled
            title="Coming soon"
          >
            <Icon.Search size={11} /> Search past runs
          </button>
          <button
            className="pill ghost"
            style={{ height: 24 }}
            disabled
            title="Coming soon"
          >
            <Icon.Layers size={11} /> Compare releases
          </button>
        </div>
      </div>

      {/* Command bar */}
      <CommandBar />
    </div>
  );
}
