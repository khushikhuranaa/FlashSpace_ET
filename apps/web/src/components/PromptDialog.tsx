import { useEffect, useRef, useState } from 'react';

/**
 * Single-field modal used where the old UI called window.prompt: folder names
 * and file renames. Keeps focus, Escape handling and validation consistent.
 */
export function PromptDialog({
  open,
  title,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Save',
  maxLength = 255,
  busy = false,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  maxLength?: number;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep the latest cancel handler without re-running the open effect. The
  // parent re-renders once per second (countdown), which would otherwise reset
  // whatever the user is typing.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    const timer = window.setTimeout(() => inputRef.current?.select(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, initialValue]);

  if (!open) return null;

  const trimmed = value.trim();

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="w-full max-w-md animate-fade-in rounded-xl border border-line bg-white p-6 shadow-xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSubmit(trimmed);
        }}
      >
        <h2 id="prompt-dialog-title" className="font-display text-[17px] font-bold text-primary">
          {title}
        </h2>
        <label className="mt-4 block">
          <span className="field-label">{label}</span>
          <input
            ref={inputRef}
            className="input"
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy || trimmed.length === 0}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
