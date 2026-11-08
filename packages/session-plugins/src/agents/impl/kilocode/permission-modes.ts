import type { ProviderPermissionModeMap } from '@gugu/session-core/acp/models/permissions';

/**
 * `mode` config option on Kilo 7.8.27: code / ask / debug / orchestrator / plan.
 * `ask` is a real read-only tier: `write` and `edit` leave the tool list and a forced call fails.
 * Full access is a permission rule (`permission: "allow"`), not a mode.
 */
export const KILOCODE_PERMISSION_MODES = {
  plan: { id: 'plan' },
  'read-only': { id: 'ask' },
  edit: { id: 'code', aliases: ['debug', 'orchestrator'] },
} satisfies ProviderPermissionModeMap;
