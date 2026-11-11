import type { JSX, ReactNode } from "react";

export interface FieldSelectProps {
  label: string;
  options: readonly string[];
  value?: string;
  onChange?: (v: string) => void;
  hint?: string;
  /** Names the select for screen readers when there is no visible label. */
  ariaLabel?: string;
}

export function FieldSelect({
  label,
  options,
  value,
  onChange,
  hint,
  ariaLabel,
}: FieldSelectProps): JSX.Element {
  return (
    <div className="col" style={{ gap: 6 }}>
      {label && (
        <label
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: "var(--color-text-2)",
          }}
        >
          {label}
        </label>
      )}
      <div className="input" style={{ height: 32 }}>
        <select
          aria-label={ariaLabel}
          value={value ?? options[0]}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-text-1)",
            font: "inherit",
          }}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      {hint && (
        <span className="dim" style={{ fontSize: 11 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function SectionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="card" style={{ padding: 18, marginBottom: 18 }}>
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-0)",
          }}
        >
          {title}
        </div>
        {hint && (
          <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }}>
            {hint}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export function Row({
  label,
  hint,
  children,
  align = "center",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  align?: string;
}): JSX.Element {
  return (
    <div
      className="row"
      style={{
        gap: 16,
        padding: "12px 0",
        borderTop: "1px solid var(--color-border-1)",
        alignItems: align,
      }}
    >
      <div style={{ flex: "0 0 220px" }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--color-text-1)",
          }}
        >
          {label}
        </div>
        {hint && (
          <div
            className="dim"
            style={{ fontSize: 11, marginTop: 3, lineHeight: 1.4 }}
          >
            {hint}
          </div>
        )}
      </div>
      <div className="flex1">{children}</div>
    </div>
  );
}
