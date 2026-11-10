import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Small metric tile: label, big value, optional context line, optional action
 * chip and optional footer (for progress bars or legends).
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  chip,
  children,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: IconName;
  chip?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-line bg-white p-4 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        {chip ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
            {chip}
          </span>
        ) : icon ? (
          <Icon name={icon} size={16} className="text-slate-400" />
        ) : null}
      </div>
      <div className="mt-3">
        <div className="font-display text-2xl font-bold tracking-tight text-primary">{value}</div>
        {hint && <p className="mt-0.5 text-[12px] text-muted">{hint}</p>}
        {children}
      </div>
    </div>
  );
}
