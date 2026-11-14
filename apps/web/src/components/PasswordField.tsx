import { useId, useState } from 'react';
import { passwordStrength } from '../lib/password';

const BAR_COLORS = ['bg-red-400', 'bg-red-400', 'bg-amber-400', 'bg-lime-500', 'bg-emerald-500'];

/**
 * Password input with show/hide and an optional strength meter.
 * The meter is advisory: the API enforces the real policy.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder = 'At least 8 characters',
  showStrength = false,
  email = '',
  required = true,
  id,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  showStrength?: boolean;
  email?: string;
  required?: boolean;
  id?: string;
  hint?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? `password-${generatedId}`;
  const [visible, setVisible] = useState(false);
  const strength = passwordStrength(value, email);

  return (
    <div className="block">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          className="input pr-16"
          type={visible ? 'text' : 'password'}
          required={required}
          minLength={8}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-describedby={showStrength && value ? `${inputId}-strength` : undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-medium text-muted hover:bg-slate-100 hover:text-primary"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>

      {showStrength && value && (
        <div id={`${inputId}-strength`} className="mt-2">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all ${BAR_COLORS[strength.score]}`}
                style={{ width: `${strength.percent}%` }}
              />
            </div>
            <span className="text-[11px] font-medium text-muted">{strength.label}</span>
          </div>
          {strength.problems.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">
              {strength.problems.map((problem) => (
                <li key={problem}>• {problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {hint && !value && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}
