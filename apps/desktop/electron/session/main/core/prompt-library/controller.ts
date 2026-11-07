import { createRPCController } from '@shared/lib/ipc/rpc';
import { type PromptLibraryPrompt } from '@shared/prompt-library';
import { promptLibraryService } from './service';

export const promptLibraryController = createRPCController({
  get: (): Promise<PromptLibraryPrompt[]> => promptLibraryService.getPrompts(),
  save: (prompt: PromptLibraryPrompt): Promise<PromptLibraryPrompt[]> => promptLibraryService.savePrompt(prompt),
  delete: (id: string): Promise<PromptLibraryPrompt[]> => promptLibraryService.deletePrompt(id),
});
