import { buildApp } from './app.js';

const { app, ctx } = buildApp();

const port = ctx.env.port;
app.listen(port, () => {
  console.log(`FlashSpace API listening on http://localhost:${port} (env: ${ctx.env.nodeEnv}, repo: ${ctx.env.repoMode}, storage: ${ctx.env.storageMode})`);
});

// Local dev convenience: run the lifecycle pass every 5 minutes in-process.
// In production, the GitHub Action cron (or any scheduler) hits POST /jobs/lifecycle/run.
const intervalMs = 5 * 60 * 1000;
setInterval(() => {
  ctx.services.lifecycle
    .runLifecyclePass({ source: 'cron', jobSecret: ctx.env.jobSecret })
    .then((r) => {
      if (r.scanned > 0 && (r.warned || r.archived || r.finalized || r.failures.length)) {
        console.log('[lifecycle]', JSON.stringify(r));
      }
    })
    .catch((err) => console.error('[lifecycle] failed', err));
}, intervalMs).unref();
