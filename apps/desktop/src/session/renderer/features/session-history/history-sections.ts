import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { rowOpens } from '@/session/shared/remote-sessions/session-directory';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import type {
  SessionHistoryDirectoryRow,
  SessionHistoryRow,
  SessionHistorySort,
  SessionHistorySource,
  SessionHistoryStatus,
} from '@shared/core/session-history/session-history';

// 任务历史跨机器合并(项目与机器解耦 §5):项目是账号级的,机器只是每一行的属性。
// 每台问得到的机器各自给一份排好序的目录页(主进程已按项目归节、排好、截好);离线的机器只有心跳摘要里那 ≤50 条。
// 这里按同一个排序键把各台的有序列表归并(❌ 重排:单台时顺序与主进程给的逐条相同),再按「节」聚到一起 ——
// 同一个项目在几台机器上的目录落进同一节。哪一行 / 哪个目录归哪一节由调用方给(它认得侧栏的项目行)。

/** 一行 + 它在哪台机器上。离线机器的行来自心跳摘要:`opens` 照侧栏 / 手机同一条 rowOpens。 */
export type HistoryEntry = SessionHistoryRow & { machine: string; offline: boolean; opens: boolean };

/** 一节是谁:key 稳定;machine 非空 = 这一节是某台机器上的一个目录(没对上任何项目),节头要标机器。 */
export type SectionRef = { key: string; label: string; path: string | null; machine: string | null };

export type HistorySection = SectionRef & {
  /** 在线那几台在这一节里一共几条(主进程数的,可能多于 preview)。 */
  onlineCount: number;
  providers: string[];
  /** 在线那几台上归进这一节的目录:「显示更多」按它们逐台要。 */
  members: Array<{ machine: string; directory: string | null }>;
  /** 在线那几台随目录页带回的头几条,已归并。 */
  preview: HistoryEntry[];
  /** 离线机器在这一节里的行(心跳摘要),已排好。 */
  offline: HistoryEntry[];
  offlineMachines: string[];
};

type Sortable = { updatedAt: number; lastPromptAt: number | null; addedAt: number | null };

/** 与主进程 list-session-history 同一套排序:时间倒序、没有那个时间的排最后、字母正序;并列按更新时间倒序。 */
export function compareBy<T extends Sortable>(sort: SessionHistorySort, nameOf: (row: T) => string) {
  const byTime = (pick: (row: T) => number | null) => (a: T, b: T) => {
    const av = pick(a);
    const bv = pick(b);
    if (av === null && bv === null) return b.updatedAt - a.updatedAt;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || b.updatedAt - a.updatedAt;
  };
  switch (sort) {
    case 'lastPrompt':
      return byTime((row) => row.lastPromptAt);
    case 'added':
      return byTime((row) => row.addedAt);
    case 'title':
      return (a: T, b: T) => nameOf(a).localeCompare(nameOf(b)) || b.updatedAt - a.updatedAt;
    case 'updated':
      return byTime((row) => row.updatedAt);
  }
}

/** 把几份各自有序的列表归并成一份;每份内部的先后不变。 */
export function mergeSorted<T>(lists: ReadonlyArray<readonly T[]>, compare: (a: T, b: T) => number): T[] {
  const heads = lists.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i += 1) {
      if (heads[i] >= lists[i].length) continue;
      if (best < 0 || compare(lists[i][heads[i]], lists[best][heads[best]]) < 0) best = i;
    }
    if (best < 0) return out;
    out.push(lists[best][heads[best]]);
    heads[best] += 1;
  }
}

/** 在线机器读来的一行。别的机器的行 key 带上机器:本机行按文件路径认,两台上可以撞。 */
export function entryOf(machine: string, row: SessionHistoryRow): HistoryEntry {
  return { ...row, key: machine === LOCAL_IMPORT_DEVICE ? row.key : `${machine}/${row.key}`, machine, offline: false, opens: true };
}

/** 离线机器心跳摘要里的一条:咕咕自己的活跃会话(摘要里没有归档的、也没有原件)。 */
export function digestEntry(machine: string, session: SessionpageSessionSummary): HistoryEntry {
  const at = session.lastInteractedAt ? Date.parse(session.lastInteractedAt) : NaN;
  const updatedAt = Number.isFinite(at) ? at : 0;
  return {
    key: `${machine}/gugu:${session.conversationId}`,
    source: 'gugu',
    status: 'active',
    title: session.title,
    providerSessionId: null,
    providerId: session.harness,
    directory: session.cwd ?? null,
    projectName: null,
    updatedAt,
    lastPromptAt: Number.isFinite(at) ? at : null,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    gugu: { projectId: session.projectId, sessionId: session.conversationId, runtime: session.runtime === 'pty' ? 'pty' : 'acp' },
    machine,
    offline: true,
    opens: rowOpens(session),
  };
}

/** 摘要行在渲染侧按同一套筛选过一遍(主进程看不到它们):来源 / 状态 / 关键词(空格分词全部命中)。 */
export function digestMatches(
  entry: HistoryEntry,
  filters: { source?: SessionHistorySource; status?: SessionHistoryStatus; query?: string }
): boolean {
  if (filters.source && filters.source !== entry.source) return false;
  if (filters.status && filters.status !== entry.status) return false;
  const haystack = [entry.title, entry.directory ?? '', entry.gugu?.sessionId ?? ''].join('\n').toLowerCase();
  return (filters.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

type Item = Sortable & { ref: SectionRef; online?: { machine: string; row: SessionHistoryDirectoryRow }; offline?: HistoryEntry };

/**
 * 各台的目录页 + 离线行 → 一节一个项目。节的先后 = 归并后它第一次出现的位置;节内的行按同一排序归并。
 * `sectionOfDirectory` 给在线目录定节,`sectionOfEntry` 给离线行定节(同一个「项目 → 侧栏项目行」的判据)。
 */
export function buildSections({
  sort,
  pages,
  offline,
  sectionOfDirectory,
  sectionOfEntry,
}: {
  sort: SessionHistorySort;
  pages: ReadonlyArray<{ machine: string; rows: readonly SessionHistoryDirectoryRow[] }>;
  offline: readonly HistoryEntry[];
  sectionOfDirectory: (machine: string, row: SessionHistoryDirectoryRow) => SectionRef;
  sectionOfEntry: (entry: HistoryEntry) => SectionRef;
}): HistorySection[] {
  const compareRows = compareBy<HistoryEntry>(sort, (row) => row.title);
  // 节的先后:在线的是目录、离线的是单条,两种东西只有「它归哪一节」是同一种 —— 按标题排时就按节名(项目名)比,
  // ❌ 拿目录路径与会话标题互相比(归并的前提「各路同一把尺子、各自有序」就不成立了)。各路先按这把尺子排好再归并。
  const compareItems = compareBy<Item>(sort, (item) => item.ref.label);
  const onlineItems = pages.map(({ machine, rows }) =>
    rows.map((row): Item => ({ ...pickSortable(row), ref: sectionOfDirectory(machine, row), online: { machine, row } }))
      .sort(compareItems)
  );
  const offlineItems = offline
    .map((entry): Item => ({ ...pickSortable(entry), ref: sectionOfEntry(entry), offline: entry }))
    .sort(compareItems);

  const sections = new Map<string, HistorySection & { previews: HistoryEntry[][] }>();
  for (const item of mergeSorted([...onlineItems, offlineItems], compareItems)) {
    let section = sections.get(item.ref.key);
    if (!section) {
      section = { ...item.ref, onlineCount: 0, providers: [], members: [], preview: [], offline: [], offlineMachines: [], previews: [] };
      sections.set(item.ref.key, section);
    }
    const providers = item.online ? item.online.row.providers : item.offline?.providerId ? [item.offline.providerId] : [];
    for (const provider of providers) if (!section.providers.includes(provider)) section.providers.push(provider);
    if (item.online) {
      const { machine, row } = item.online;
      section.onlineCount += row.sessionCount;
      section.members.push({ machine, directory: row.directory });
      section.previews.push(row.sessions.map((session) => entryOf(machine, session)));
    } else if (item.offline) {
      section.offline.push(item.offline);
      if (!section.offlineMachines.includes(item.offline.machine)) section.offlineMachines.push(item.offline.machine);
    }
  }
  return [...sections.values()].map(({ previews, ...section }) => ({ ...section, preview: mergeSorted(previews, compareRows) }));
}

function pickSortable(row: Sortable): Sortable {
  return { updatedAt: row.updatedAt, lastPromptAt: row.lastPromptAt, addedAt: row.addedAt };
}
