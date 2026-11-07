import { localizedManifestText, localizedPromptText } from '@shared/extensions/catalog';
import { promptsChangedChannel, type PromptLibraryPrompt } from '@shared/prompt-library';
import { events } from '@main/lib/events';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { sessionHostLocale } from '@main/core/host-locale';
import { promptLibraryService } from '@main/core/prompt-library/service';

/**
 * `gugu.prompts` (34, `prompts`): what the 「Prompt 管理」 App's program does for its agent — the person's own prompts, the
 * same account row the composer's `/` reads (prompt-library.ts). An App's prompts are listed, never written. A delete
 * is shown to the person at once with its undo (prompt-changes.ts).
 */
const fail = (message: string) => Object.assign(new Error(message), { code: 'invalid' });

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${field} is a non-empty string`);
  return value.trim();
}

function enabledApps() {
  const service = extensionsService();
  return service.list().extensions.filter(({ manifest }) => service.isEnabled(manifest.id)).map(({ manifest }) => manifest);
}

function changed(action: 'save' | 'delete', prompt: PromptLibraryPrompt, appId: string) {
  // The write is done: naming the App must not turn it into an error (an App disabled mid-call is named by its id).
  const manifest = extensionsService().list().extensions.find((extension) => extension.manifest.id === appId)?.manifest;
  events.emit(promptsChangedChannel, { action, prompt, app: manifest ? localizedManifestText(manifest, sessionHostLocale()).name : appId });
}

export async function promptsForApp(method: 'promptsList' | 'promptsSave' | 'promptsDelete', args: Record<string, unknown>, appId: string): Promise<unknown> {
  if (method === 'promptsList') {
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const matches = (...fields: string[]) => !query || fields.some((field) => field.toLowerCase().includes(query));
    const locale = sessionHostLocale();
    return {
      prompts: (await promptLibraryService.getPrompts()).filter((prompt) => matches(prompt.title, prompt.prompt)),
      app_prompts: enabledApps().flatMap((manifest) => (manifest.contributes.prompts ?? [])
        .map((prompt) => ({ app: localizedManifestText(manifest, locale).name, ...localizedPromptText(manifest, prompt, locale) }))
        .filter((prompt) => matches(prompt.title, prompt.prompt))),
    };
  }
  if (method === 'promptsSave') {
    const id = args.id === undefined ? undefined : text(args.id, 'id');
    const saved: PromptLibraryPrompt = { id: id ?? globalThis.crypto.randomUUID(), title: text(args.title, 'title'), prompt: text(args.prompt, 'prompt') };
    await promptLibraryService.editPrompts((all) => {
      if (!id) return [...all, saved];
      if (!all.some((prompt) => prompt.id === id)) throw fail(`No prompt ${id}: list gives the ids`);
      return all.map((prompt) => (prompt.id === id ? saved : prompt));
    });
    changed('save', saved, appId);
    return { id: saved.id, saved: true };
  }
  const id = text(args.id, 'id');
  let deleted: PromptLibraryPrompt | undefined;
  await promptLibraryService.editPrompts((all) => {
    deleted = all.find((prompt) => prompt.id === id);
    if (!deleted) throw fail(`No prompt ${id}: list gives the ids`);
    return all.filter((prompt) => prompt.id !== id);
  });
  changed('delete', deleted!, appId);
  return { deleted: id };
}
