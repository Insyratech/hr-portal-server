import { buildApp } from './app';
import { loadEnv } from './config/env';
import { startWorkJobScheduler } from './jobs/scheduler';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  // Only the real server runs reminders; buildApp is also used by tests and tooling.
  // Must be before listen(): the scheduler registers an onClose hook.
  startWorkJobScheduler(app, env);

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
