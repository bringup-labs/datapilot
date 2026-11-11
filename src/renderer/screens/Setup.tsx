import { useEffect, useRef, useState, type JSX } from "react";
import type { DockerStatus } from "@shared/ipc";
import { Icon } from "@renderer/components/Icon";
import { Button } from "@renderer/components/ui";
import logoUrl from "@renderer/assets/logo.png";

interface SetupProps {
  status: DockerStatus;
  onRetry: () => void;
}

export function Setup({ status, onRetry }: SetupProps): JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  // Track the "show checkmark" timeout so rapid re-clicks don't pile up
  // overlapping timers (which would prematurely reset the indicator) and so
  // we cancel it on unmount instead of calling setState on a dead component.
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(null);
        copyTimeoutRef.current = null;
      }, 2000);
    });
  };

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  if (status.state === "pending") {
    const progress = status.progress ?? 0;
    const stepText = status.step ?? "Initializing…";

    return (
      <div className="setup-container">
        <div className="setup-card fade-in">
          <div className="setup-header">
            <div className="setup-logo setup-logo--img">
              <img src={logoUrl} alt="DataPilot" draggable={false} />
            </div>
            <div className="setup-title-group">
              <h1 className="setup-title">Environment setup</h1>
              <p className="setup-subtitle">Orchestrating stack dependencies</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-text-2">
              Initializing Neo4j database, FastAPI backend, and MCP workers…
            </p>

            {/* Glassmorphic progress bar */}
            <div
              style={{
                width: "100%",
                height: 8,
                background: "var(--color-bg-3)",
                backdropFilter: "blur(8px)",
                borderRadius: 4,
                overflow: "hidden",
                position: "relative",
                border: "1px solid var(--color-border-1)",
                boxShadow: "var(--color-shadow-inset)",
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: "100%",
                  background:
                    "linear-gradient(90deg, var(--color-accent) 0%, oklch(0.68 0.15 280) 100%)",
                  borderRadius: 4,
                  boxShadow: "0 0 12px var(--color-accent)",
                  transition: "width 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              />
            </div>

            {/* Step & percentage details */}
            <div className="flex justify-between items-center px-1 text-xs">
              <span
                className="text-text-2 font-medium truncate max-w-[70%]"
                title={stepText}
              >
                {stepText}
              </span>
              <span className="text-accent font-semibold mono">
                {progress}%
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 px-4 py-2 rounded bg-bg-2 border border-border-1 text-text-3 font-mono text-xs pulse w-fit">
            <Icon.Refresh
              size={14}
              style={{ animation: "spin 1.4s linear infinite" }}
            />
            <span>docker compose status: pending</span>
          </div>
        </div>
      </div>
    );
  }

  // Defensive guard for the (currently unused) 'ready' branch — the parent
  // App.tsx unmounts Setup once status flips to ready, so this is just a
  // type-narrowing nicety.
  if (status.state !== "error") {
    return (
      <div className="setup-container">
        <div className="setup-card items-center justify-center py-16 text-center">
          <p className="text-text-3">Status: {status.state}</p>
        </div>
      </div>
    );
  }

  const { code, message } = status;
  let title = "Environment setup error";
  let subtitle =
    "DataPilot was unable to start the local Docker services stack.";
  let icon = <Icon.Alert size={24} style={{ color: "var(--color-danger)" }} />;
  let remediationTitle = "Suggested resolution";
  let remediationContent: JSX.Element | null = null;
  let showOpenDockerBtn = false;

  switch (code) {
    case "daemon_off":
      title = "Docker daemon offline";
      subtitle = "Docker Desktop is not running on your host system.";
      icon = <Icon.Alert size={24} style={{ color: "var(--color-danger)" }} />;
      remediationContent = (
        <div className="flex flex-col gap-2">
          <p className="text-text-2">
            DataPilot requires Docker Desktop to orchestrate the local database,
            backend API, and worker nodes.
          </p>
          <p className="text-text-2 font-medium">
            Please start Docker Desktop and wait for it to become active, then
            retry.
          </p>
        </div>
      );
      showOpenDockerBtn = true;
      break;

    case "permission_denied": {
      title = "Docker socket permission denied";
      subtitle = "Insufficient permissions to connect to the Docker socket.";
      icon = <Icon.Alert size={24} style={{ color: "var(--color-danger)" }} />;
      remediationTitle = "Terminal resolution";
      const chmodCmd = "sudo chmod 666 /var/run/docker.sock";
      remediationContent = (
        <div className="flex flex-col gap-3">
          <p className="text-text-2">
            The application encountered a permission error (
            <code className="mono text-danger text-xs bg-bg-2 px-1 rounded">
              EACCES
            </code>
            ) when trying to access the Unix domain socket. Run the following
            command in your terminal to grant read/write access:
          </p>
          <div className="setup-code-block">
            <span className="row gap-2">
              <Icon.Terminal
                size={14}
                style={{ color: "var(--color-text-3)" }}
              />
              <span className="setup-code-cmd text-text-0 mono select-all">
                {chmodCmd}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon
              onClick={() => copyToClipboard(chmodCmd)}
              title="Copy to clipboard"
            >
              {copied === chmodCmd ? (
                <Icon.Check size={13} style={{ color: "var(--color-ok)" }} />
              ) : (
                <Icon.File size={13} />
              )}
            </Button>
          </div>
          <p className="text-text-3 text-xs italic">
            Note: this command changes the socket permissions locally so
            standard processes can connect.
          </p>
        </div>
      );
      break;
    }

    case "port_conflict": {
      title = "Network port conflict";
      subtitle = "Required ports (7474, 7687, or 8000) are already bound.";
      icon = <Icon.Alert size={24} style={{ color: "var(--color-danger)" }} />;
      remediationTitle = "Conflicting processes";
      const conflictCmd = "lsof -i :7474 -i :7687 -i :8000";
      remediationContent = (
        <div className="flex flex-col gap-3">
          <p className="text-text-2">
            Another service on your machine is using the ports needed by Neo4j
            or FastAPI. Run this command to find the conflicting process IDs:
          </p>
          <div className="setup-code-block">
            <span className="row gap-2">
              <Icon.Terminal
                size={14}
                style={{ color: "var(--color-text-3)" }}
              />
              <span className="setup-code-cmd text-text-0 mono select-all">
                {conflictCmd}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon
              onClick={() => copyToClipboard(conflictCmd)}
              title="Copy to clipboard"
            >
              {copied === conflictCmd ? (
                <Icon.Check size={13} style={{ color: "var(--color-ok)" }} />
              ) : (
                <Icon.File size={13} />
              )}
            </Button>
          </div>
          <p className="text-text-2">
            Terminate the conflicting processes or services, then retry.
          </p>
        </div>
      );
      break;
    }

    case "image_pull_failed":
      title = "Registry ingestion failure";
      subtitle = "Unable to pull required Docker images or build containers.";
      icon = (
        <Icon.Download size={24} style={{ color: "var(--color-danger)" }} />
      );
      // The message names the image that failed and why, with what to do about it.
      remediationContent = (
        <div className="flex flex-col gap-2">
          <p className="text-text-2">{message}</p>
        </div>
      );
      break;

    default:
      title = "Integration stack failure";
      subtitle = "An unexpected error occurred during container startup.";
      icon = <Icon.Alert size={24} style={{ color: "var(--color-danger)" }} />;
      remediationContent = (
        <div className="flex flex-col gap-2">
          <p className="text-text-2">
            The environment could not boot successfully. Details:
          </p>
          <pre className="mono text-xs text-danger bg-bg-2 p-3 rounded border border-border-1 max-h-36 overflow-y-auto whitespace-pre-wrap select-all">
            {message}
          </pre>
        </div>
      );
  }

  return (
    <div className="setup-container">
      <div className="setup-card fade-in">
        <div className="setup-header">
          <div className="setup-logo setup-logo--img">
            <img src={logoUrl} alt="DataPilot" draggable={false} />
          </div>
          <div className="setup-title-group">
            <h1 className="setup-title">Environment setup</h1>
            <p className="setup-subtitle">
              Dependency &amp; stack verification
            </p>
          </div>
        </div>

        <div className="setup-status error">
          <div className="row gap-2">
            {icon}
            <span className="setup-status-label">{title}</span>
          </div>
          <div className="setup-status-message mt-1">{subtitle}</div>
        </div>

        <div className="setup-remediation">
          <span className="setup-remediation-title">{remediationTitle}</span>
          <div className="mt-2 text-text-1">{remediationContent}</div>
        </div>

        <div className="setup-actions">
          {showOpenDockerBtn && (
            <Button
              variant="primary"
              onClick={onRetry}
              title="Open Docker Desktop and retry"
            >
              <Icon.Activity size={14} />
              Launch Docker &amp; Retry
            </Button>
          )}
          <Button
            variant={showOpenDockerBtn ? "ghost" : "primary"}
            onClick={onRetry}
            title="Retry connecting to Docker"
          >
            <Icon.Refresh size={14} />
            Retry connection
          </Button>
        </div>
      </div>
    </div>
  );
}
