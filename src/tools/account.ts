import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, schemaConfirm, McpToolError } from '@chrischall/mcp-utils';
import type { RemindClient } from '../client.js';
import { ME, NOTIFICATION_SETTINGS, UPDATE_NOTIFICATIONS } from '../queries.js';

export function registerAccountTools(server: McpServer, client: RemindClient): void {
  server.registerTool(
    'remind_me',
    {
      description:
        'Get the signed-in Remind account: uuid, name, email, locale, admin/child flags and sign-in count.',
      annotations: toolAnnotations({ title: 'Remind account', readOnly: true, idempotent: true }),
      inputSchema: {},
    },
    async () => textResult(await client.graphql(ME)),
  );

  server.registerTool(
    'remind_get_notification_settings',
    {
      description:
        'Get notification settings: reply/announcement-copy/incoming-call preferences plus every registered ' +
        'delivery device (email, sms, apns) with its enabled state. The `canManage*` flags say which ' +
        'preferences this account is actually allowed to change — a subscriber account cannot change most.',
      annotations: toolAnnotations({ title: 'Remind notification settings', readOnly: true, idempotent: true }),
      inputSchema: {},
    },
    async () => textResult(await client.graphql(NOTIFICATION_SETTINGS)),
  );

  server.registerTool(
    'remind_set_notification_devices',
    {
      description:
        'Enable or disable notification delivery devices by id (from remind_get_notification_settings). ' +
        'Without confirm:true this makes NO network call and returns a dry-run preview of the exact mutation input.',
      annotations: toolAnnotations({ title: 'Remind set notification devices', readOnly: false }),
      inputSchema: {
        enable: z.array(z.number().int()).optional().describe('Device ids to enable.'),
        disable: z.array(z.number().int()).optional().describe('Device ids to disable.'),
        confirm: schemaConfirm,
      },
    },
    async ({ enable, disable, confirm }) => {
      const input: Record<string, number[]> = {};
      if (enable?.length) input.devicesToEnable = enable;
      if (disable?.length) input.devicesToDisable = disable;
      if (!Object.keys(input).length) {
        throw new McpToolError('Nothing to do: pass at least one device id in `enable` or `disable`.');
      }
      if (!confirm) {
        return textResult({
          dryRun: true,
          wouldSend: { mutation: 'updateAccountNotificationsScreen', input },
          note: 'Re-run with confirm: true to apply.',
        });
      }
      await client.graphql(UPDATE_NOTIFICATIONS, { input });
      // A 200 is not proof: re-read and report the devices' observed state.
      const after = await client.graphql<{
        accountNotificationsScreen: { devices: { id: number; isEnabled: boolean }[] };
      }>(NOTIFICATION_SETTINGS);
      const touched = new Set([...(enable ?? []), ...(disable ?? [])]);
      return textResult({
        applied: input,
        verifiedState: after.accountNotificationsScreen.devices
          .filter((d) => touched.has(d.id))
          .map((d) => ({ id: d.id, isEnabled: d.isEnabled })),
      });
    },
  );
}
