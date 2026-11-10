import { describe, expect, it } from 'vitest';
import type { SessionHistoryDirectoryRow } from '@shared/core/session-history/session-history';
import { buildSections, mergeSorted, type HistoryEntry, type SectionRef } from './history-sections';

const dir = (directory: string, updatedAt: number): SessionHistoryDirectoryRow => ({
  key: directory, directory, projectName: null, sessionCount: 1, countsBySource: {} as never, countsByStatus: {} as never,
  providers: [], updatedAt, lastPromptAt: null, addedAt: null, sessions: [],
}) as unknown as SessionHistoryDirectoryRow;
const offline = (title: string, project: string, updatedAt: number): HistoryEntry => ({
  key: title, title, updatedAt, lastPromptAt: null, addedAt: null, machine: 'wen', offline: true, opens: false,
  directory: `/${project}`, gugu: { projectId: project, sessionId: title, runtime: 'acp' },
}) as unknown as HistoryEntry;
// Sections are projects; a directory and an offline task both land in the project they belong to.
const ref = (project: string): SectionRef => ({ key: project, label: project, path: null, machine: null });
const projectOfDirectory = (directory: string) => ({ '/srv/zzz-dir': 'alpha', '/srv/aaa-dir': 'zulu' } as Record<string, string>)[directory] ?? directory.slice(1);

describe('history sections across machines', () => {
  // #2412 review ⑤: by title, online directories and offline task rows must be compared on the same key (the section).
  it('orders sections by project name under the title sort, whatever directory path or task title they hold', () => {
    const sections = buildSections({
      sort: 'title',
      // Main-process order on that machine: by directory path.
      pages: [{ machine: 'gpu', rows: [dir('/srv/aaa-dir', 1), dir('/srv/zzz-dir', 2)] }],
      offline: [offline('a task title', 'mid', 3), offline('zz last title', 'alpha', 4)],
      sectionOfDirectory: (_machine, row) => ref(projectOfDirectory(row.directory ?? '')),
      sectionOfEntry: (entry) => ref(entry.gugu!.projectId),
    });
    expect(sections.map((section) => section.key)).toEqual(['alpha', 'mid', 'zulu']);
    expect(sections.find((section) => section.key === 'alpha')!.offline.map((row) => row.title)).toEqual(['zz last title']);
  });

  it('keeps time order across machines when sorting by update time', () => {
    const sections = buildSections({
      sort: 'updated',
      pages: [{ machine: 'gpu', rows: [dir('/srv/zzz-dir', 5), dir('/srv/aaa-dir', 1)] }],
      offline: [offline('t', 'mid', 3)],
      sectionOfDirectory: (_machine, row) => ref(projectOfDirectory(row.directory ?? '')),
      sectionOfEntry: (entry) => ref(entry.gugu!.projectId),
    });
    expect(sections.map((section) => section.key)).toEqual(['alpha', 'mid', 'zulu']);
  });

  it('merges already sorted lists into one sorted list', () => {
    expect(mergeSorted([[1, 4, 9], [2, 3], [10]], (a, b) => a - b)).toEqual([1, 2, 3, 4, 9, 10]);
  });
});
