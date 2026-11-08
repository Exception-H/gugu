import z from 'zod';
import {
  readUserSettingsConfig,
  updateUserSettingsConfig,
  type SettingsTableClient,
  type VersionedSettingsTableClient,
} from '@gugu/core/cloud/userSettings';
import { defineEvent } from '@shared/lib/ipc/events';

export const promptLibraryPromptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
});

export const promptLibrarySchema = z.array(promptLibraryPromptSchema);

export type PromptLibraryPrompt = z.infer<typeof promptLibraryPromptSchema>;

/** The person's version of an App's prompt (owner 11-08): edited, or hidden. Keyed `<App id>/<prompt name>`. */
const promptOverrideSchema = z.union([z.strictObject({ hidden: z.literal(true) }), z.strictObject({ title: z.string().min(1), prompt: z.string().min(1) })]);
export type PromptOverride = z.infer<typeof promptOverrideSchema>;

export type PromptLibrary = { items: PromptLibraryPrompt[]; overrides: Record<string, PromptOverride> };

export type AppPrompt = { key: string; title: string; prompt: string };
export type PromptState = 'default' | 'modified' | 'hidden';

/**
 * An App's prompts as the person sees them, the one merge `/`, the library page and `gugu.prompts.list` share: their
 * override if any, else the App's current text, so an App update reaches what they never touched. Restoring the
 * default is removing the override.
 */
export function withOverrides<T extends AppPrompt>(prompts: readonly T[], overrides: PromptLibrary['overrides']): (T & { state: PromptState })[] {
  return prompts.map((prompt) => {
    const override = overrides[prompt.key];
    if (!override) return { ...prompt, state: 'default' };
    return 'hidden' in override ? { ...prompt, state: 'hidden' } : { ...prompt, ...override, state: 'modified' };
  });
}

export const PROMPT_LIBRARY_SEED_VERSION = 1;

/**
 * The person's prompts are the account's (owner 11-07): one `identity.user_settings` row, read by every computer. The
 * row and its RLS already exist, so this needs no migration; writes are conditional on the row's version
 * (`updateUserSettingsConfig`), so two computers never overwrite each other's edit. Its own scope, not a key of `user`:
 * a prompt edit never contends with the other settings' writes.
 */
const SCOPE = 'prompts';

function libraryOf(config: Record<string, unknown>): PromptLibrary {
  return { items: promptLibrarySchema.parse(config.items ?? []), overrides: z.record(z.string(), promptOverrideSchema).parse(config.overrides ?? {}) };
}

export async function readCloudPrompts(client: SettingsTableClient, userId: string): Promise<PromptLibrary> {
  return libraryOf(await readUserSettingsConfig(client, userId, SCOPE));
}

/** Apply `edit` to the latest row. */
export async function editCloudPrompts(
  client: VersionedSettingsTableClient,
  userId: string,
  edit: (library: PromptLibrary) => PromptLibrary,
): Promise<PromptLibrary> {
  const row = await updateUserSettingsConfig(client, userId, SCOPE, (config) => ({ ...config, ...libraryOf(edit(libraryOf(config))) }));
  return libraryOf(row.config);
}

/** Main → renderer: an App's program changed the person's prompts. The list re-reads; a delete offers its undo (saving it back). */
export const promptsChangedChannel = defineEvent<{ action: 'save' | 'delete'; prompt: PromptLibraryPrompt; app: string }>('prompts.changed');
