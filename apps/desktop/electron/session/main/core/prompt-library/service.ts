import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings';
import type { IInitializable } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { appSettings } from '@main/db/schema';
import {
  PROMPT_LIBRARY_SEED_VERSION,
  editCloudPrompts,
  promptLibrarySchema,
  readCloudPrompts,
  type PromptLibraryPrompt,
} from '@shared/prompt-library';

type PromptLibraryKV = {
  prompts: PromptLibraryPrompt[];
  seedVersion: number;
  /** The last list read for an account here: what `/` shows while the cloud can't be reached. */
  lastRead: { userId: string; prompts: PromptLibraryPrompt[] };
};

type PromptEdit = (prompts: PromptLibraryPrompt[]) => PromptLibraryPrompt[];

/**
 * The prompts are the account's (owner 11-07): one `user_settings` row (prompt-library.ts). Main reads and writes it
 * with the account's token — the session page is given no credentials (assistantPanelBridge.ts).
 */
async function account(): Promise<{ client: VersionedSettingsTableClient; userId: string }> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId) throw Object.assign(new Error('Not signed in'), { code: 'failed' });
  return { client: createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } }) as unknown as VersionedSettingsTableClient, userId };
}

const promptLibraryKV = new KV<PromptLibraryKV>('prompt-library');

export class PromptLibraryService implements IInitializable {
  private seedPromise: Promise<void> | null = null;

  private async readPrompts(): Promise<PromptLibraryPrompt[]> {
    const prompts = await promptLibraryKV.get('prompts');
    const parsed = promptLibrarySchema.safeParse(prompts ?? []);
    return parsed.success ? parsed.data : [];
  }

  private async readLegacyAppSetting(key: string): Promise<unknown | null> {
    const rows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    const raw = rows[0]?.value;
    if (!raw) return null;

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private async deleteLegacyPromptSettings(): Promise<void> {
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrary'));
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrarySeedVersion'));
    await db.delete(appSettings).where(eq(appSettings.key, 'reviewPrompt'));
  }

  private async seedIfNeeded(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;

    this.seedPromise = (async () => {
      const seedVersion = await promptLibraryKV.get('seedVersion');
      if ((seedVersion ?? 0) >= PROMPT_LIBRARY_SEED_VERSION) {
        await this.deleteLegacyPromptSettings();
        return;
      }

      const existingPrompts = await this.readPrompts();
      const legacyPromptLibrary = promptLibrarySchema.safeParse(
        await this.readLegacyAppSetting('promptLibrary')
      );
      const legacyReviewPrompt = await this.readLegacyAppSetting('reviewPrompt');
      const prompts = [...existingPrompts];
      if (legacyPromptLibrary.success) {
        for (const legacyPrompt of legacyPromptLibrary.data) {
          if (!prompts.some((prompt) => prompt.id === legacyPrompt.id)) {
            prompts.push(legacyPrompt);
          }
        }
      }
      // 不再给新用户塞一条预设(10-07 资源库体检:中文界面里第一屏就是一条英文的「Review prompt」,
      // 空状态那句已经说清这页是干什么的)。老版本里用户**自己改过**的那条 review prompt 仍照搬过来 —— 那是他的内容。
      const legacyReview = typeof legacyReviewPrompt === 'string' && legacyReviewPrompt.trim()
        && !prompts.some((prompt) => prompt.id === 'review-prompt')
        ? [{ id: 'review-prompt', title: 'Review prompt', prompt: legacyReviewPrompt.trim() }]
        : [];
      const nextPrompts = [...legacyReview, ...prompts];

      if (nextPrompts.length > 0) {
        await promptLibraryKV.set('prompts', nextPrompts);
      }
      await promptLibraryKV.set('seedVersion', PROMPT_LIBRARY_SEED_VERSION);
      await this.deleteLegacyPromptSettings();
    })().finally(() => {
      this.seedPromise = null;
    });

    await this.seedPromise;
  }

  async initialize(): Promise<void> {
    await this.seedIfNeeded();
  }

  /**
   * This computer's old local list goes into the first account signed in here, once, by id; then it is cleared, so no
   * later account on this computer gets it.
   */
  private async mergeLocal(client: VersionedSettingsTableClient, userId: string): Promise<void> {
    await this.seedIfNeeded();
    const local = await this.readPrompts();
    if (local.length === 0) return;
    await editCloudPrompts(client, userId, (cloud) => [...cloud, ...local.filter((prompt) => !cloud.some((other) => other.id === prompt.id))]);
    await promptLibraryKV.set('prompts', []);
  }

  private async remember(userId: string, prompts: PromptLibraryPrompt[]): Promise<PromptLibraryPrompt[]> {
    await promptLibraryKV.set('lastRead', { userId, prompts });
    return prompts;
  }

  /** The account's list; offline, the last one read here for that account. */
  async getPrompts(): Promise<PromptLibraryPrompt[]> {
    const { client, userId } = await account();
    try {
      await this.mergeLocal(client, userId);
      return await this.remember(userId, await readCloudPrompts(client, userId));
    } catch (error) {
      const last = await promptLibraryKV.get('lastRead');
      if (last?.userId === userId) return last.prompts;
      throw error;
    }
  }

  /** Apply `edit` to the latest row (conditional on its version); returns the saved list. */
  async editPrompts(edit: PromptEdit): Promise<PromptLibraryPrompt[]> {
    const { client, userId } = await account();
    await this.mergeLocal(client, userId);
    return this.remember(userId, await editCloudPrompts(client, userId, edit));
  }

  /** Create, or replace the one with this id; the undo of a delete saves the prompt back. */
  savePrompt(prompt: PromptLibraryPrompt): Promise<PromptLibraryPrompt[]> {
    return this.editPrompts((all) => (all.some((item) => item.id === prompt.id) ? all.map((item) => (item.id === prompt.id ? prompt : item)) : [...all, prompt]));
  }

  deletePrompt(id: string): Promise<PromptLibraryPrompt[]> {
    return this.editPrompts((all) => all.filter((item) => item.id !== id));
  }
}

export const promptLibraryService = new PromptLibraryService();
