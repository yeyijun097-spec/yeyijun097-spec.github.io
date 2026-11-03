export function createGracefulStopController({
  runtime = process,
  log = (message) => console.log(message)
} = {}) {
  let installed = false;
  let requested = false;
  let requestedSignal = "";
  let stopCallback = null;
  let stopCallbackInvoked = false;

  const invokeStopCallback = () => {
    if (!requested || !stopCallback || stopCallbackInvoked) return;
    stopCallbackInvoked = true;
    Promise.resolve()
      .then(() => stopCallback({ signal: requestedSignal }))
      .catch((error) => {
        log(`终止清理失败，将继续保存已完成结果：${error?.message || error}`);
      });
  };

  const requestStop = (signal = "SIGINT") => {
    if (requested) {
      log("再次收到终止请求，立即强制退出。");
      runtime.exit(130);
      return;
    }
    requested = true;
    requestedSignal = signal;
    log(`收到${signal}终止请求，正在保存已完成结果并停止当前页面操作...`);
    invokeStopCallback();
  };

  const handlers = {
    SIGINT: () => requestStop("SIGINT"),
    SIGTERM: () => requestStop("SIGTERM")
  };

  return {
    get requested() {
      return requested;
    },
    get signal() {
      return requestedSignal;
    },
    install() {
      if (installed) return;
      runtime.on("SIGINT", handlers.SIGINT);
      runtime.on("SIGTERM", handlers.SIGTERM);
      installed = true;
    },
    dispose() {
      if (!installed) return;
      const remove = typeof runtime.off === "function"
        ? runtime.off.bind(runtime)
        : runtime.removeListener.bind(runtime);
      remove("SIGINT", handlers.SIGINT);
      remove("SIGTERM", handlers.SIGTERM);
      installed = false;
    },
    requestStop,
    setOnStopRequested(callback) {
      stopCallback = typeof callback === "function" ? callback : null;
      invokeStopCallback();
    },
    async runIfActive(task) {
      if (requested) return { started: false };
      await task();
      return { started: true };
    }
  };
}

/**
 * 在终止信号到达时保存已完整提交的行。
 *
 * 该写入器故意是同步且只执行一次：信号回调不必等待当前
 * DOM/模型请求返回，也不需要在每一行之间主动让出事件循环。
 * getUpdates 只能返回已进入 results 的完整结果，当前半成品行不得包含。
 */
export function createCompletedResultsCheckpoint({
  enabled,
  outputPath,
  getUpdates,
  write,
  log = (message) => console.log(message)
}) {
  let saved = false;
  let savedRows = 0;

  return {
    get saved() {
      return saved;
    },
    get savedRows() {
      return savedRows;
    },
    save() {
      if (!enabled) return { saved: false, savedRows: 0, reason: "write-disabled" };
      if (saved) return { saved: true, savedRows, reason: "already-saved" };

      const updates = [...(getUpdates?.() || [])];
      const writeResult = write(updates);
      saved = true;
      savedRows = updates.length;
      log(`终止快照已写回：保留 ${savedRows} 行完整识别结果到 ${outputPath}`);
      return { saved: true, savedRows, writeResult, reason: "saved" };
    }
  };
}
