import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  McpToolError,
  confirmTokenParam,
  confirmationFromEnv,
  minifiedResult,
  requireConfirmationWithFallback,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { ME, NOTIFICATION_SETTINGS, UPDATE_NOTIFICATIONS } from '../queries.js';

export function registerAccountTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_me',
    {
      description:
        'Get the signed-in Remind account: uuid, name, email, locale, admin/child flags and sign-in count.',
      annotations: toolAnnotations({ title: 'Remind account', readOnly: true, idempotent: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.graphql(ME)),
  );

  server.registerTool(
    'remind_get_notification_settings',
    {
      description:
        'Get notification settings: reply/announcement-copy/incoming-call preferences plus every registered ' +
        'delivery device (email, sms, apns) with its enabled state. The `canManage*` flags say which ' +
        'preferences this account is actually allowed to change — a subscriber account cannot change most.',
      annotations: toolAnnotations({ title: 'Remind notification settings', readOnly: true, idempotent: true }),
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.graphql(NOTIFICATION_SETTINGS)),
  );

  server.registerTool(
    'remind_set_notification_devices',
    {
      description:
        'Enable or disable notification delivery devices by id (from remind_get_notification_settings). ' +
        'Nothing is sent until confirmed; the preview shows the exact mutation input. ' +
        'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).',
      annotations: toolAnnotations({ title: 'Remind set notification devices', readOnly: false, destructive: false }),
      inputSchema: z.object({
        enable: z.array(z.number().int()).optional().describe('Device ids to enable.'),
        disable: z.array(z.number().int()).optional().describe('Device ids to disable.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ enable, disable, confirmToken }, ctx) => {
      const input: Record<string, number[]> = {};
      if (enable?.length) input.devicesToEnable = enable;
      if (disable?.length) input.devicesToDisable = disable;
      if (!Object.keys(input).length) {
        throw new McpToolError('Nothing to do: pass at least one device id in `enable` or `disable`.');
      }
      const wouldSend = { mutation: 'updateAccountNotificationsScreen', input };
      const gate = await requireConfirmationWithFallback(
        ctx,
        confirmationFromEnv({
          action: 'notifications.set_devices',
          message: 'Review and confirm this notification device change:',
          details: wouldSend,
          tool: 'remind_set_notification_devices',
          confirmToken,
          subject: () => ({ target: '', payload: wouldSend, preview: { wouldSend } }),
        }),
      );
      if (gate) return gate;
      await client.graphql(UPDATE_NOTIFICATIONS, { input });
      // A 200 is not proof: re-read and report the devices' observed state.
      const after = await client.graphql<{
        accountNotificationsScreen: { devices: { id: number; isEnabled: boolean }[] };
      }>(NOTIFICATION_SETTINGS);
      const touched = new Set([...(enable ?? []), ...(disable ?? [])]);
      return minifiedResult({
        applied: input,
        verifiedState: after.accountNotificationsScreen.devices
          .filter((d) => touched.has(d.id))
          .map((d) => ({ id: d.id, isEnabled: d.isEnabled })),
      });
    },
  );
}
