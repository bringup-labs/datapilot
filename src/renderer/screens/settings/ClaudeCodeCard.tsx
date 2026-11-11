import { useEffect, type JSX } from "react";
import { Button, Toggle } from "@renderer/components/ui";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import { useSettingsStore } from "@renderer/stores/settings";
import {
  CLAUDE_CODE_MODEL_OPTIONS,
  modelDisplayName,
  signedInLabel,
  toolsLabel,
} from "@renderer/lib/claudeCodeCopy";
import { CLAUDE_CODE_MIN_VERSION } from "@shared/ipc";
import { FieldSelect, Row, SectionCard } from "./parts";

const MONO = { fontFamily: "var(--font-mono)", fontSize: 11.5 } as const;
const SMALL = { fontSize: 11.5, lineHeight: 1.5 } as const;

export function ClaudeCodeCard(): JSX.Element {
  const status = useClaudeCodeStore((s) => s.status);
  const signingIn = useClaudeCodeStore((s) => s.signingIn);
  const error = useClaudeCodeStore((s) => s.error);
  const refresh = useClaudeCodeStore((s) => s.refresh);
  const signIn = useClaudeCodeStore((s) => s.signIn);
  const chooseBinary = useClaudeCodeStore((s) => s.chooseBinary);
  const openInstallGuide = useClaudeCodeStore((s) => s.openInstallGuide);
  const copilotEngine = useSettingsStore((s) => s.copilotEngine);
  const claudeCodeModel = useSettingsStore((s) => s.claudeCodeModel);
  const setSetting = useSettingsStore((s) => s.setSetting);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = status?.install;
  const auth = status?.auth ?? null;
  const tools = status?.tools;
  const usingClaudeCode = copilotEngine === "claude_code";
  const modelLabel = modelDisplayName(claudeCodeModel);
  // Signed in or not, the folder shows which Claude Code sign-in DataPilot
  // reads, so a different one from the terminal's stands out.
  const settingsFolder = auth?.configDirectory ? (
    <div className="dim" style={SMALL}>
      {`Settings folder: ${auth.configDirectory}`}
    </div>
  ) : null;

  return (
    <SectionCard
      title="Claude Code on this computer"
      hint="Answers Copilot questions with the Claude Code installed here, using its own sign-in."
    >
      <Row label="Installed" align="flex-start">
        <div className="col" style={{ gap: 8 }}>
          {install?.state === "found" && (
            <>
              <div style={{ fontSize: 12.5 }}>
                {`Claude Code ${install.version}`}
              </div>
              <div className="dim" style={MONO}>
                {install.path}
              </div>
            </>
          )}
          {install?.state === "too_old" && (
            <>
              <div style={{ fontSize: 12.5 }}>
                {`DataPilot needs Claude Code ${CLAUDE_CODE_MIN_VERSION} or later`}
              </div>
              <div className="dim" style={SMALL}>
                {`Found ${install.version} at ${install.path}. Run `}
                <code style={MONO}>claude update</code>
                {" in a terminal."}
              </div>
              <div className="row gap-2">
                <Button size="sm" onClick={() => void refresh()}>
                  Check again
                </Button>
              </div>
            </>
          )}
          {install?.state === "missing" && (
            <>
              <div style={{ fontSize: 12.5 }}>Not found on this computer.</div>
              <div className="row gap-2">
                <Button size="sm" onClick={() => void openInstallGuide()}>
                  Open install guide
                </Button>
                <Button size="sm" onClick={() => void refresh()}>
                  Check again
                </Button>
                <Button size="sm" onClick={() => void chooseBinary()}>
                  Choose location…
                </Button>
              </div>
            </>
          )}
          {!install && <div className="dim">—</div>}
          {error && (
            <div role="alert" style={{ ...SMALL, color: "var(--color-err)" }}>
              {error}
            </div>
          )}
        </div>
      </Row>

      <Row label="Signed in" align="flex-start">
        {!auth && <div className="dim">—</div>}
        {auth?.signedIn && (
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontSize: 12.5 }}>{signedInLabel(auth.method)}</div>
            {settingsFolder}
          </div>
        )}
        {auth && !auth.signedIn && (
          <div className="col" style={{ gap: 8 }}>
            <div className="col" style={{ gap: 4 }}>
              <div style={{ fontSize: 12.5 }}>Claude Code isn't signed in.</div>
              {settingsFolder}
            </div>
            <div className="row gap-2">
              <Button size="sm" disabled={signingIn} onClick={() => void signIn()}>
                {signingIn
                  ? "Waiting for sign-in in your browser…"
                  : "Sign in with Claude Code"}
              </Button>
            </div>
            <div className="dim" style={SMALL}>
              {"Or run "}
              <code style={MONO}>claude</code>
              {" in a terminal and type /login."}
            </div>
            <div className="dim" style={SMALL}>
              If you set ANTHROPIC_API_KEY, a proxy or a cloud provider in your
              shell, DataPilot doesn't see it when opened from the Dock or app
              menu. Put those settings in the env block of Claude Code's
              settings file, or sign in with Claude Code.
            </div>
          </div>
        )}
      </Row>

      <Row label="DataPilot's tools">
        {!tools && <div className="dim">—</div>}
        {tools?.reachable && (
          <div style={{ fontSize: 12.5 }}>{toolsLabel(tools.names.length)}</div>
        )}
        {tools && !tools.reachable && (
          <div className="col" style={{ gap: 8 }}>
            <div style={{ fontSize: 12.5 }}>
              Not reachable yet. DataPilot's services may still be starting.
            </div>
            <div className="row gap-2">
              <Button size="sm" onClick={() => void refresh()}>
                Check again
              </Button>
            </div>
          </div>
        )}
      </Row>

      <Row label="Model">
        <FieldSelect
          label=""
          ariaLabel="Model"
          options={CLAUDE_CODE_MODEL_OPTIONS.map((o) => o.label)}
          value={modelLabel}
          onChange={(label) => {
            const option = CLAUDE_CODE_MODEL_OPTIONS.find(
              (o) => o.label === label,
            );
            if (option) void setSetting("claudeCodeModel", option.value);
          }}
        />
      </Row>

      <Row label="Use for Copilot">
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <Toggle
            label="Use for Copilot"
            on={usingClaudeCode}
            // Always allow turning it off, even when a check now fails.
            disabled={!status?.ready && !usingClaudeCode}
            onChange={(next) =>
              void setSetting("copilotEngine", next ? "claude_code" : "datapilot")
            }
          />
          {!status?.ready && (
            <span className="dim" style={SMALL}>
              Available when every check above passes.
            </span>
          )}
        </div>
      </Row>

      <div
        className="dim"
        style={{
          ...SMALL,
          paddingTop: 12,
          borderTop: "1px solid var(--color-border-1)",
        }}
      >
        Your question and the log excerpts Claude Code reads go to Anthropic
        under your own account. DataPilot never sees your Claude sign-in.
      </div>
    </SectionCard>
  );
}
