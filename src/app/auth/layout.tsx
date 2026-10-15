import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--background)] p-8 shadow-sm">
        {children}
      </div>
    </div>
  );
}
