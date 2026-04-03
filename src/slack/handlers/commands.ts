import { App } from '@slack/bolt';
import { config } from '../../config';
import { HealthMonitor } from '../../monitoring/health';

export function registerCommandHandlers(app: App, healthMonitor: HealthMonitor): void {
  app.command('/comcheck-status', async ({ ack, respond, command }) => {
    await ack();

    // Admin-only check
    if (!config.adminUserIds.includes(command.user_id)) {
      await respond('Sorry, this command is only available to admins.');
      return;
    }

    try {
      const health = await healthMonitor.getHealth();
      const text = healthMonitor.formatHealthForSlack(health);
      await respond(text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await respond(`Error fetching status: ${msg}`);
    }
  });
}
