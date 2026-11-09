import { observable, runInAction } from 'mobx';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import { log } from '@renderer/utils/logger';

/**
 * 账号上的项目(identity.list_my_projects,项目与机器解耦):项目就是它的项目群,一个文件夹都没有也在。
 * 有文件夹的项目已经是侧栏上的一行(各台机器的本地项目按群并好);这一份补上的是「哪台机器上都还没有文件夹」的那些。
 * 项目选择器打开时读一次;读不到照实进日志,列表留着上一份。
 */
class AccountProjectsStore {
  readonly projects = observable.array<AccountProject>([], { deep: false });
  private inFlight: Promise<void> | null = null;

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const read = import('@/lib/deviceProjects')
      .then((cloud) => cloud.listMyAccountProjects())
      .then((list) => { runInAction(() => { this.projects.replace(list); }); })
      .catch((error: unknown) => { log.warn('[projects] read the account project list failed', error); })
      .finally(() => { this.inFlight = null; });
    this.inFlight = read;
    return read;
  }

  /** 一个文件夹都没有、也没归档的项目(这几行侧栏上没有)。 */
  get withoutFolders(): AccountProject[] {
    return this.projects.filter((project) => !project.archived && project.bindings.length === 0);
  }
}

export const accountProjectsStore = new AccountProjectsStore();
