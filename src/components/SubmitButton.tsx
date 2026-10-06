"use client";

import { useFormStatus } from "react-dom";

/** Submit button that announces its pending state and prevents double submits. */
export function SubmitButton({ children, pendingLabel, className = "btn", ...rest }: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      {...rest}
      className={className}
      type="submit"
      aria-disabled={pending}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
