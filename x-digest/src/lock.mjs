/**
 * 全局「重活」锁。
 *
 * 摘要一轮、@ 检查一轮、手动触发，都会开浏览器 + 连 x.com。
 * 之前它们可以同时跑：结果既慢又容易超时（代理那边扛不住并发）。
 * 这里用一条 promise 链把它们串起来，谁先拿到谁跑完，下一个再上。
 */

let chain = Promise.resolve();

export function withHeavyLock(fn) {
  const run = chain.then(fn, fn);
  // 不管成功失败，链都要往下走；吞掉错误避免 unhandled rejection
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
