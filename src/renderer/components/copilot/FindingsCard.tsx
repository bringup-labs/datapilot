import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SeverityDot } from "@renderer/components/ui/SeverityDot";
import type { Finding } from "@shared/types";
import type { Severity } from "@renderer/components/ui/SeverityDot";

interface FindingsCardProps {
  findings: Finding[];
}

const SEV_MAP: Record<Finding["sev"], Severity> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

export function FindingsCard({ findings }: FindingsCardProps): JSX.Element {
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--color-border-1)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--color-text-2)",
          letterSpacing: "0.03em",
          textTransform: "uppercase",
        }}
      >
        Key findings
      </div>
      <div className="col">
        {findings.map((f, i) => (
          <div
            key={i}
            className="row gap-2"
            style={{
              padding: "8px 10px",
              borderTop: i ? "1px solid var(--color-border-1)" : "none",
              alignItems: "flex-start",
            }}
          >
            <SeverityDot sev={SEV_MAP[f.sev]} />
            <div className="flex1">
              <div
                className="chat-md"
                style={{
                  fontSize: 12.5,
                  color: "var(--color-text-1)",
                  lineHeight: 1.45,
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {f.text}
                </ReactMarkdown>
              </div>
              {f.logIds && f.logIds.length > 0 && (
                <div
                  className="dim mono"
                  style={{ fontSize: 10.5, marginTop: 3 }}
                >
                  {f.logIds
                    .map((id) => id.slice(id.lastIndexOf(":") + 1))
                    .join(" · ")}
                </div>
              )}
              {f.detail && (
                <div
                  className="dim mono chat-md"
                  style={{ fontSize: 10.5, marginTop: 3 }}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {f.detail}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
