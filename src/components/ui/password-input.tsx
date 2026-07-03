"use client";

import { useState, type InputHTMLAttributes } from "react";
import { Input } from "./input";

/**
 * Password input with a show/hide (eye) toggle.
 * Forwards all input props (autoComplete, minLength, required, value/onChange, disabled).
 * The toggle is a real <button> with an aria-label + aria-pressed for screen readers.
 */
export function PasswordInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        type={shown ? "text" : "password"}
        className={`pr-9 ${className ?? ""}`}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        disabled={props.disabled}
        tabIndex={props.disabled ? -1 : 0}
        className="absolute inset-y-0 right-0 w-9 grid place-items-center text-text-dim hover:text-text disabled:opacity-40"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

function Eye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 0 0 4.24 4.24" />
      <path d="M9.9 4.6A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-3.06 3.66" />
      <path d="M6.3 6.3A17.9 17.9 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.2-.88" />
    </svg>
  );
}
