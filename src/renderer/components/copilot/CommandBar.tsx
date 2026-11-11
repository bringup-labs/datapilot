import { useState, useEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { Icon } from "@renderer/components/Icon";
import { useChatStore } from "@renderer/stores/chat";
import { useChat } from "@renderer/hooks/useChat";

export function CommandBar(): JSX.Element {
  const [input, setInput] = useState("");
  const streaming = useChatStore((s) => s.streaming);
  const pendingResend = useChatStore((s) => s.pendingResend);
  const { send, stop } = useChat();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevStreaming = useRef(streaming);

  // A next-step button (Retry, Answer with DataPilot's agents) queues its
  // question; send it once nothing is streaming. The live store is read and
  // cleared first, so the question goes exactly once, even when React runs
  // this effect twice for one render.
  useEffect(() => {
    const chat = useChatStore.getState();
    const question = chat.pendingResend;
    if (!question || chat.streaming) return;
    chat.clearResend();
    send(question);
  }, [pendingResend, streaming, send]);

  // Return focus to the input once the assistant finishes responding, so the
  // user can keep typing without reaching for the mouse. The textarea is
  // disabled while streaming, so focus has to be restored after it re-enables.
  useEffect(() => {
    if (prevStreaming.current && !streaming) {
      textareaRef.current?.focus();
    }
    prevStreaming.current = streaming;
  }, [streaming]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    send(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{ padding: "8px 14px 14px", flexShrink: 0 }}>
      <div
        className="col"
        style={{
          background: "var(--color-bg-3)",
          border: "1px solid var(--color-border-2)",
          borderRadius: 10,
          padding: "10px 12px",
          gap: 8,
        }}
      >
        <textarea
          ref={textareaRef}
          placeholder="Ask anything about this run, or paste a topic name…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          rows={2}
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-text-0)",
            fontFamily: "var(--font-ui)",
            fontSize: 13,
            resize: "none",
            lineHeight: 1.45,
            opacity: streaming ? 0.6 : 1,
          }}
        />
        <div className="row gap-2">
          <button
            className="btn ghost icon sm"
            title="Voice input — not available yet"
            disabled
            style={{ opacity: 0.35, cursor: "not-allowed" }}
          >
            <Icon.Mic size={13} />
          </button>
          <button
            className="btn ghost icon sm"
            title="Attach (not available)"
            disabled
          >
            <Icon.Upload size={13} />
          </button>
          <span className="dim mono" style={{ fontSize: 10.5 }}>
            ⌘↵ to send
          </span>
          <div className="flex1" />
          {streaming ? (
            <button
              className="btn danger sm"
              onClick={stop}
              title="Stop generating"
            >
              <Icon.Stop size={12} />
              Stop
            </button>
          ) : (
            <button
              className="btn primary sm"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <Icon.Send size={12} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
