import type { ReactNode } from "react";

type Props = {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
};

export function Field({ label, htmlFor, error, hint, children }: Props) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-[var(--foreground)]"
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="text-xs text-[var(--muted-foreground)]">{hint}</p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
