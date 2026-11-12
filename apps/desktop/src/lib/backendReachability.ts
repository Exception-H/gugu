// @@@backend-recovered — 「后端又能用了」只有一个读数:账号同步节拍的那一拉(`sync_since`;账号还没有游标时是
// `sync_snapshot`,列表的读失败态也出自这一拉)。它失败过、又成功了,就是后端恢复;别处失败的写(发送、已读、
// 起任务要票)都在这一刻自己重来,❌ 各自再认 window `online`(网络通而后端不通时它不会响)、❌ 各自起轮询。
// 节拍本身(25 s / 可见 / 联网 / 前台)归 accountRevisionReconcile。
//
// 只认「失败 → 成功」这条边:后端一直通着时,一条因别的原因失败的写不会被反复重投(那是死循环,不是恢复)。
// 一条写失败时请节拍立刻再拉一次(probe):后端真断着,这一拉也失败,边就挂上了 —— 比一个节拍短的中断也看得见。

type Listener = () => void

const listeners = new Set<Listener>()
let answering = true
let probe: (() => void) | null = null

/** 同步那一拉的结果。中止(换号 / 停止)不算读数。 */
export function noteBackendAnswer(ok: boolean): void {
  const recovered = ok && !answering
  answering = ok
  if (recovered) for (const listener of [...listeners]) listener()
}

export function subscribeBackendRecovered(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 一次后端写失败了:请节拍现在就拉一次,好知道后端是不是断了。 */
export function noteBackendWriteFailed(): void {
  probe?.()
}

/** 节拍的主人(账号作用域)接上「现在拉一次」;换号时撤掉,并回到「后端可达」的初值。 */
export function bindBackendProbe(pull: () => void): () => void {
  probe = pull
  return () => {
    if (probe === pull) probe = null
    answering = true
  }
}
