import { useChatStore } from "@renderer/stores/chat";
import { useSessionStore } from "@renderer/stores/session";
import { useSettingsStore } from "@renderer/stores/settings";
import * as api from "@renderer/services/api";
import { streamClaudeCode } from "@renderer/services/claudeCode";
import {
  claudeCodeFields,
  nextStepsFor,
  toCausalItems,
  toFindings,
  toPlanSteps,
} from "@renderer/lib/chatMapping";
import { STOPPED_BY_USER, claudeCodeErrorText } from "@shared/claudeCodeMessages";
import type { ClaudeCodeErrorCode, ClaudeCodeModel } from "@shared/ipc";
import type { ChatAction, ChatMessage, PlanStep } from "@shared/types";

interface UseChatReturn {
  send: (message: string) => void;
  stop: () => void;
}

interface PlanEventData {
  plan: Array<{ specialist?: string; label?: string }>;
}

interface StepAddEventData {
  label: string;
}

interface StepEventData {
  idx: number;
  confidence?: number;
  output_summary?: string;
}

interface FinalEventData {
  response?: string;
  findings?: Array<{ sev?: string; text?: string; detail?: string }>;
  audit_trail?: Array<{ result_summary?: string }>;
  causal?: unknown[];
  citations?: unknown[];
  usage?: {
    tokens_in: number;
    tokens_out: number;
    est_cost_usd?: number;
  };
  /** Set on Claude Code's answers only. */
  answered_by?: "claude_code";
}

interface ErrorEventData {
  message?: string;
  /**
   * DataPilot's errors carry its own codes (chat_error, graph_error,
   * session_budget_exceeded, no_final); Claude Code's carry a ClaudeCodeErrorCode.
   */
  code?: string;
}

const timeNow = () =>
  new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });

function patchStep(m: ChatMessage, idx: number, patch: Partial<PlanStep>): ChatMessage {
  if (!m.plan) return m;
  return { ...m, plan: m.plan.map((step, i) => (i === idx ? { ...step, ...patch } : step)) };
}

/** The answer has ended, so none of its steps is still running. */
function settleSteps(m: ChatMessage): ChatMessage {
  if (!m.plan?.some((step) => step.active)) return m;
  return { ...m, plan: m.plan.map((step) => (step.active ? { ...step, active: false } : step)) };
}

/**
 * Whether an answer's events still apply: it is the chat's current answer and
 * its message is still shown. A new question replaces it; a cleared chat, or
 * another bag's, detaches it, and it then finishes and saves to its own bag.
 */
function isShown(assistantId: string): boolean {
  const { answer, messages } = useChatStore.getState();
  return answer?.assistantId === assistantId && messages.some((m) => m.id === assistantId);
}

/**
 * The system message for a failed answer. Only Claude Code's errors offer a
 * way forward and keep the question to resend. DataPilot's carry codes too,
 * but stay as they were.
 */
function errorMessage(question: string, data: ErrorEventData, claudeCode: boolean): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "system",
    text: data.message ?? "An error occurred.",
    ...(claudeCode && data.code
      ? {
          nextSteps: nextStepsFor(data.code as ClaudeCodeErrorCode),
          retryQuestion: question,
        }
      : {}),
  };
}

/**
 * Writes the events of one answer, from either engine, into the chat store,
 * on that answer's own message. It reads and writes only global stores, so it
 * keeps working after the Copilot unmounts on a screen switch.
 * `claudeCode` marks the Claude Code transport, whose errors offer next steps.
 */
function createEventHandler(
  question: string,
  assistantId: string,
  { claudeCode = false }: { claudeCode?: boolean } = {},
): api.ChatEventHandler {
  return (event, data) => {
    if (!isShown(assistantId)) return;
    const chat = useChatStore.getState();
    const update = (updater: (m: ChatMessage) => ChatMessage) =>
      chat.updateMessageById(assistantId, updater);

    if (event === "plan") {
      const planData = data as PlanEventData;
      // Only show the plan card when there are actual steps.
      // General chat sends plan:[] to make the backend feel responsive — ignore it.
      const plan = toPlanSteps(planData.plan, false);
      if (plan) {
        update((m) => ({ ...m, plan }));
      }
    } else if (event === "step-add") {
      // Claude Code adds a step as each tool call starts.
      const { label } = data as StepAddEventData;
      update((m) => ({
        ...m,
        plan: [...(m.plan ?? []), { label, done: false, active: true }],
      }));
    } else if (event === "step-start") {
      const { idx } = data as StepEventData;
      update((m) => patchStep(m, idx, { active: true }));
    } else if (event === "step-done") {
      const { idx, confidence, output_summary } = data as StepEventData;
      update((m) =>
        patchStep(m, idx, {
          done: true,
          active: false,
          confidence,
          outputSummary: output_summary,
        }),
      );
    } else if (event === "final") {
      const final = data as FinalEventData;

      const actions: ChatAction[] = useSessionStore.getState().sessionId
        ? [
            {
              iconName: "Clock",
              label: "Jump to timeline",
              target: "timeline",
            },
            {
              iconName: "Graph",
              label: "See causal graph",
              target: "kgraph",
            },
            {
              iconName: "Activity",
              label: "Metric: lidar latency",
              target: "metrics",
            },
          ]
        : [];

      update((m) =>
        settleSteps({
          ...m,
          summary: final.response,
          findings: toFindings(final.findings),
          causal: toCausalItems(final.causal),
          actions,
          // Claude Code's tokens aren't DataPilot's spend: they stay out of the
          // header's session total, and its own usage line shows them.
          usage: final.answered_by === undefined ? final.usage : undefined,
          ...claudeCodeFields(data as Record<string, unknown>),
        }),
      );

      chat.setStreaming(false);
    } else if (event === "kgraph") {
      // The turn distilled new facts into the knowledge graph — refetch it
      // so they appear without reloading the session. Read the live session
      // id so a mid-stream session switch resolves against the right one (#35).
      const { sessionId, setTabData } = useSessionStore.getState();
      if (sessionId) {
        api
          .getKGraph(sessionId)
          .then((g) => setTabData("kgraph", g))
          .catch((err) =>
            console.error("knowledge graph refresh failed:", err),
          );
      }
    } else if (event === "error") {
      update(settleSteps);
      chat.addMessage(errorMessage(question, data as ErrorEventData, claudeCode));
      chat.setStreaming(false);
    }
  };
}

/**
 * Makes a new answer the chat's current one and starts it. The answer is
 * registered first, because a transport may report an error before it returns.
 */
function startAnswer(
  assistantId: string,
  sessionId: string | null,
  begin: () => { abort(): void },
): void {
  const chat = useChatStore.getState();
  chat.setAnswer({ assistantId, sessionId, handle: null });
  chat.setStreaming(true);
  const handle = begin();
  if (useChatStore.getState().answer?.assistantId === assistantId) {
    chat.setAnswer({ assistantId, sessionId, handle });
  }
}

/**
 * Claude Code answers questions about the loaded bag only. Without one it
 * says so and offers DataPilot's agents; it never falls back to them silently.
 */
function askClaudeCode(question: string, model: ClaudeCodeModel): void {
  const chat = useChatStore.getState();
  const { sessionId, status } = useSessionStore.getState();

  chat.addMessage({ id: crypto.randomUUID(), role: "user", text: question });
  if (!sessionId || status !== "ready") {
    chat.addMessage(
      errorMessage(question, { code: "no_bag", message: claudeCodeErrorText("no_bag") }, true),
    );
    chat.setStreaming(false);
    return;
  }

  const assistantId = crypto.randomUUID();
  chat.addMessage({
    id: assistantId,
    role: "assistant",
    time: timeNow(),
    answeredBy: "claude_code",
  });
  startAnswer(assistantId, sessionId, () =>
    streamClaudeCode(
      { sessionId, question, model },
      createEventHandler(question, assistantId, { claudeCode: true }),
    ),
  );
}

function send(message: string): void {
  const chat = useChatStore.getState();
  // A new question replaces the previous answer, and stops it if it still runs.
  chat.answer?.handle?.abort();
  chat.setAnswer(null);

  // Read now, not at render, so a resend right after switching engines uses the new one.
  const { copilotEngine, claudeCodeModel, defaultProvider, defaultModel } =
    useSettingsStore.getState();
  if (copilotEngine === "claude_code") {
    askClaudeCode(message, claudeCodeModel);
    return;
  }

  const { sessionId } = useSessionStore.getState();
  const msgId = crypto.randomUUID();
  const assistantId = crypto.randomUUID();

  chat.addMessage({ id: msgId, role: "user", text: message });
  chat.addMessage({ id: assistantId, role: "assistant", time: timeNow() });
  startAnswer(assistantId, sessionId, () =>
    api.streamChat(
      sessionId || "general",
      message,
      createEventHandler(message, assistantId),
      defaultProvider,
      defaultModel,
    ),
  );
}

function stop(): void {
  const chat = useChatStore.getState();
  const { answer } = chat;
  answer?.handle?.abort();
  chat.setStreaming(false);
  if (!answer) return;
  chat.setAnswer({ ...answer, handle: null });
  // Target the assistant message this answer was writing to by id, so the
  // marker never lands on a trailing system/error message (#36).
  chat.updateMessageById(answer.assistantId, (m) =>
    settleSteps({
      ...m,
      summary: m.summary ? `${m.summary}\n\n${STOPPED_BY_USER}` : STOPPED_BY_USER,
    }),
  );
}

/**
 * Sends Copilot questions and stops answers. The answer in flight is kept in
 * the chat store, not in the component, and nothing is aborted on unmount: a
 * screen switch unmounts the Copilot while the answer keeps streaming, and the
 * remounted Copilot shows it and can still stop it.
 */
export function useChat(): UseChatReturn {
  return { send, stop };
}
