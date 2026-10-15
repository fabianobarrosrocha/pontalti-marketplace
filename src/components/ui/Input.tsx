import { clsx } from "clsx";
import { forwardRef, type InputHTMLAttributes } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          "h-11 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)] disabled:opacity-50",
          className
        )}
        {...rest}
      />
    );
  }
);
