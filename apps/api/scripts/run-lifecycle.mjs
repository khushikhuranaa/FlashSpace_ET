/**
 * Scheduler entrypoint (Module 15).
 *
 * Render/Fly cron (or GitHub Actions) runs this on a schedule; it calls the
 * API's authenticated lifecycle endpoint. The pass is idempotent per
 * (date, space, phase), so retries and overlapping schedules are safe.
 *
 *   API_BASE_URL=https://api.example.com JOB_SECRET=... node run-lifecycle.mjs
 */
const base = process.env.API_BASE_URL;
const secret = process.env.JOB_SECRET;

if (!base || !secret) {
  console.error('API_BASE_URL and JOB_SECRET are required');
  process.exit(1);
}

try {
  const response = await fetch(`${base.replace(/\/$/, '')}/jobs/lifecycle/run`, {
    method: 'POST',
    headers: { 'x-job-secret': secret },
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`lifecycle run failed: ${response.status} ${body}`);
    process.exit(1);
  }
  console.log(`lifecycle run ok: ${body}`);
} catch (err) {
  console.error(`lifecycle run error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
