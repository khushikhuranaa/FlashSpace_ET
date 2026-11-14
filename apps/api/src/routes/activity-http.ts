import type { Response } from 'express';
import type { ActivityQuery, ActivityQueryInput } from '@flashspace/shared';

/** Map validated query parameters onto repository filters. */
export function activityFilters(
  _raw: unknown,
  parsed: ActivityQueryInput,
): ActivityQuery & { q?: string } {
  return {
    q: parsed.q,
    action: parsed.action,
    category: parsed.category,
    actorType: parsed.actorType,
    outcome: parsed.outcome,
    resourceType: parsed.resourceType,
    resourceId: parsed.resourceId,
    userId: parsed.actorId,
    from: parsed.from,
    to: parsed.to,
    sort: parsed.sort,
    limit: parsed.limit,
    offset: parsed.offset,
  };
}

/** CSV download with a safe filename and no caching of exported history. */
export function sendCsv(res: Response, file: { filename: string; csv: string; rows: number }): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Export-Rows', String(file.rows));
  res.send(file.csv);
}
