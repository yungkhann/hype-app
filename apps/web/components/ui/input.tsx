import { ChevronDown } from "lucide-react";
import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const control =
  "w-full rounded-md border border-control bg-sunken text-dense text-ink placeholder:text-ink-3 transition-colors duration-100 hover:border-ink-3 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/25 disabled:cursor-not-allowed disabled:border-line-strong disabled:text-ink-3 aria-[invalid=true]:border-critical";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-8 px-2.5", className)} {...props} />;
}

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max"> & {
  value: number | null | undefined;
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  /** Used when the field is left empty or invalid and `allowEmpty` is false. */
  fallback?: number;
  /** Empty means "use the default": commits null. */
  allowEmpty?: boolean;
  integer?: boolean;
};

/**
 * A number field that never rewrites what the user is typing. Typing "0.3" into a 0.05–0.5 field passes
 * through "0", which is out of range: the draft is kept and only in-range values are committed while typing.
 * Out-of-range or empty input is clamped (or falls back) on blur.
 */
export function NumberInput({ value, onValueChange, min, max, fallback, allowEmpty = false, integer = false, onBlur, ...props }: NumberInputProps) {
  const text = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(text);
  const [synced, setSynced] = useState(text);
  if (text !== synced) {
    // The value changed from outside (reset, loaded recipe, saved view): show it.
    setSynced(text);
    setDraft(text);
  }
  const parse = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return integer ? Math.round(n) : n;
  };
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const commit = (n: number | null) => {
    setSynced(n === null ? "" : String(n));
    if (n !== (value ?? null)) onValueChange(n);
  };

  return (
    <Input
      {...props}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={props.step ?? (integer ? 1 : "any")}
      value={draft}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const n = parse(raw);
        if (n !== null && inRange(n)) commit(n);
        else if (raw.trim() === "" && allowEmpty) commit(null);
      }}
      onBlur={(event) => {
        const n = parse(draft);
        const next = n === null ? (allowEmpty ? null : (fallback ?? value ?? null)) : clamp(n);
        setDraft(next === null ? "" : String(next));
        commit(next);
        onBlur?.(event);
      }}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-20 px-2.5 py-2 leading-relaxed", className)} {...props} />;
}

/** Native select: fastest, accessible, and keyboard-complete for dense forms. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn("relative", className)}>
      <select className={cn(control, "h-8 cursor-pointer appearance-none pr-8 pl-2.5")} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-2xs font-medium text-ink-2">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-2xs text-critical">{error}</p>
      ) : hint ? (
        <p className="text-2xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

/** Field + control with an auto id. */
export function useFieldId(prefix = "f") {
  const id = useId();
  return `${prefix}-${id.replace(/:/g, "")}`;
}
