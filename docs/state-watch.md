# 宿主状态变化监听

`runtime.watchChanges(listener, { onError })` 为外部业务层提供跨进程状态变化提示，不启动 Worker、协调者或来源监听器。运行中的服务仍是唯一执行者。方法返回取消监听函数，`runtime.close()` 也会释放该实例的所有监听器。

```javascript
const runtime = createProjectAgent({ projectRoot }).init();
const reconcile = async () => {
  // 读取 get(ticketId) 等公开接口，以持久状态判断是否需要收集业务结果。
};
const unsubscribe = runtime.watchChanges(reconcile, {
  onError: error => console.error('State watch failed:', error),
});
await reconcile(); // 先注册再补查，覆盖启动前已完成的工作。
```

监听覆盖数据库目录里的 SQLite、WAL 和 SHM 文件，WAL 文件替换后继续监听；无关文件不触发。连续变化合并处理，异步回调不重叠，回调执行中出现变化会安排后续一次读取。回调错误交给 `onError`；文件监听器本身出错会关闭本次监听并报告 `code: "WATCH_FAILED"`，应由调用方退出并重启或重新注册。

这是**当前状态失效提示，不是持久事件流**：提示可能合并、重复或因进程停止／文件系统限制而遗漏，也可能对应其他工单、运行心跳或尚未提交的写入。业务消费者应按当前工单与状态去重，仅在实际需要时收集，并保留启动补查和周期性兜底。不要把收到提示当成工单成功，不要在每次回调中启动执行或无条件写库。打开新运行时实例也可能写库，因此频繁重复初始化会造成自身唤醒。

数据库维护替换文件后，已有 SQLite 读取连接可能仍持有旧文件。监听检查文件身份，若数据库消失或身份变化，会关闭监听并通过 `onError` 报 `code: "WATCH_REOPEN_REQUIRED"`；调用方应关闭并重新打开读取实例，或退出由进程管理器重启。消费结果仍须使用业务层既有核对、锁及幂等结算规则。取消监听阻止后续调用，但已经开始的异步回调由调用方等待或自行停止。
