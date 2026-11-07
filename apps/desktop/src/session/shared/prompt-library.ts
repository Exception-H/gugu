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

export const PROMPT_LIBRARY_SEED_VERSION = 1;

/**
 * The person's prompts are the account's (owner 11-07): one `identity.user_settings` row, read by every computer. The
 * row and its RLS already exist, so this needs no migration; writes are conditional on the row's version
 * (`updateUserSettingsConfig`), so two computers never overwrite each other's edit. Its own scope, not a key of `user`:
 * a prompt edit never contends with the other settings' writes.
 */
const SCOPE = 'prompts';

function promptsOf(config: Record<string, unknown>): PromptLibraryPrompt[] {
  return promptLibrarySchema.parse(config.items ?? []);
}

export async function readCloudPrompts(client: SettingsTableClient, userId: string): Promise<PromptLibraryPrompt[]> {
  return promptsOf(await readUserSettingsConfig(client, userId, SCOPE));
}

/** Apply `edit` to the latest list. */
export async function editCloudPrompts(
  client: VersionedSettingsTableClient,
  userId: string,
  edit: (prompts: PromptLibraryPrompt[]) => PromptLibraryPrompt[],
): Promise<PromptLibraryPrompt[]> {
  const row = await updateUserSettingsConfig(client, userId, SCOPE, (config) => ({ ...config, items: promptLibrarySchema.parse(edit(promptsOf(config))) }));
  return promptsOf(row.config);
}

/** Main → renderer: an App's program changed the person's prompts. The list re-reads; a delete offers its undo (saving it back). */
export const promptsChangedChannel = defineEvent<{ action: 'save' | 'delete'; prompt: PromptLibraryPrompt; app: string }>('prompts.changed');
