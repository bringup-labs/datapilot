import type { ClaudeCodeAskRequest } from "@shared/ipc";
import { claudeCodeErrorText } from "@shared/claudeCodeMessages";
import type { ChatEventHandler } from "./api";

/**
 * Asks the user's own Claude Code, through the preload bridge, about the open
 * bag and forwards its chat events (`step-add`, `step-done`, `final`, `error`)
 * to the Copilot's chat handler. Nothing is forwarded after `final`, `error`
 * or `abort()`, and the run is then released: unsubscribed, and stopped if it
 * is still going.
 */
export function streamClaudeCode(
  request: ClaudeCodeAskRequest,
  onEvent: ChatEventHandler,
): { abort(): void } {
  const fail = () =>
    onEvent("error", { code: "failed", message: claudeCodeErrorText("failed") });

  const bridge = window.datapilot?.claudeCode;
  if (!bridge) {
    fail();
    return { abort: () => undefined };
  }

  // Unsubscribes and stops the run; given by `ask` once the run has started.
  let stopRun: (() => Promise<void>) | null = null;
  let ended = false;
  const release = (stop: () => Promise<void>) => {
    // Main may already be gone; there is nothing left to stop then.
    void stop().catch(() => undefined);
  };
  const end = () => {
    ended = true;
    if (stopRun) release(stopRun);
  };

  bridge
    .ask(request, (e) => {
      if (ended) return;
      if (e.event === "final" || e.event === "error") end();
      onEvent(e.event, e.data);
    })
    .then(
      (stop) => {
        stopRun = stop;
        // Ended before the run started: stop it now.
        if (ended) release(stop);
      },
      () => {
        if (ended) return;
        ended = true;
        fail();
      },
    );

  return {
    abort: () => {
      if (!ended) end();
    },
  };
}
