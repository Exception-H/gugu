# n8n 卡片流水线冒烟测试

这是一次性文件：验证「PR 带卡号 → CI 绿 → 三角度审计 → 自动合并 → 回卡留言 → 卡置 done」整条链路。
验证完随卡 HRM-17 一起取消，文件由后续提交删除。

## 返工记录（第 1 次）

第 1 次 CI（run 42235668266 / attempt 1）只有 `Session database, chat UI browser and tooling`
失败，且该 job 在 15 分钟后被判 cancelled，steps 为空——macOS runner 一直没领到任务，
不是代码或测试挂了。其余 job 全部 success。

按流水线要求补一次提交触发重跑，代码本身无改动。
