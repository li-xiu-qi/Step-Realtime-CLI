import { describe, expect, it } from 'vitest';
import { matchesCron, nextFireAfter, parseCron } from '../../src/agent/cron/cronexpr.js';
import { CronScheduler } from '../../src/agent/cron/scheduler.js';
import { cronCreateTool, cronListTool } from '../../src/tools/cron.js';

describe('parseCron / matchesCron / nextFireAfter', () => {
  it('解析合法表达式', () => {
    const spec = parseCron('*/5 * * * *');
    expect(spec).not.toBeNull();
    expect(spec!.minute.has(0)).toBe(true);
    expect(spec!.minute.has(5)).toBe(true);
  });

  it('非法表达式 → null', () => {
    expect(parseCron('bad')).toBeNull();
    expect(parseCron('61 * * * *')).toBeNull();
  });

  it('matchesCron 按本地时间匹配', () => {
    const spec = parseCron('30 9 * * *')!;
    const d = new Date(2026, 0, 21, 9, 30, 0);
    expect(matchesCron(spec, d)).toBe(true);
    expect(matchesCron(spec, new Date(2026, 0, 21, 9, 31, 0))).toBe(false);
  });

  it('nextFireAfter 找到下一次触发', () => {
    const spec = parseCron('0 12 * * *')!;
    const after = new Date(2026, 0, 21, 8, 0, 0);
    const next = nextFireAfter(spec, after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(12);
    expect(next!.getMinutes()).toBe(0);
  });
});

describe('CronScheduler', () => {
  it('创建任务并到点触发（isIdle 为真）', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => true, 1000);
    const job = sched.create('* * * * *', '每分钟提醒');
    // 手动把 nextFireAt 改到过去，模拟到点
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(fired).toContain('每分钟提醒');
    sched.stop();
  });

  it('isIdle 为假时不触发', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => false, 1000);
    const job = sched.create('* * * * *', 'x');
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(fired).toHaveLength(0);
    sched.stop();
  });

  it('一次性任务触发后删除', () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const job = sched.create('* * * * *', 'once', false);
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(sched.list()).toHaveLength(0);
    sched.stop();
  });

  /**
   * 2026-08-19 用户反馈：新会话启动后，旧会话（同工作目录）创建的 cron 任务被自动恢复
   * 并触发，旧任务的 prompt 在新会话里继续执行。
   *
   * 根因：cron 任务按 cwd 存储（不按 session），装配层 restore 时没按 sessionId 过滤，
   * 把同 cwd 下所有会话的任务都恢复了。修复：装配层 restore 前 filter(sessionId === 当前)。
   * 本测试钉住「快照带 sessionId」这一前提——装配层的过滤依赖它。
   */
  it('create 把当前 sessionId 写进任务（装配层据此隔离各会话）', () => {
    const sched = new CronScheduler((j) => {}, () => true, 'session-X', 100);
    const job = sched.create('*/5 * * * *', '任务', true);
    expect(job.sessionId).toBe('session-X');
    sched.stop();
  });

  it('restore 读回快照的 sessionId（旧快照无该字段时兜底为空串）', () => {
    const sched = new CronScheduler((j) => {}, () => true, 'session-Y', 100);
    sched.restore([
      { id: 'a', cron: '0 * * * *', prompt: 'p', recurring: true, nextFireAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: Date.now(), sessionId: 'session-A' },
      { id: 'b', cron: '0 * * * *', prompt: 'p', recurring: true, nextFireAt: new Date(Date.now() + 3600_000).toISOString(), createdAt: Date.now() },
    ]);
    const byId = new Map(sched.list().map((j) => [j.id, j]));
    expect(byId.get('a')!.sessionId).toBe('session-A');
    expect(byId.get('b')!.sessionId).toBe(''); // 旧快照无 sessionId → 空串
    sched.stop();
  });

  it('rebindSession 清空旧任务并换 sessionId（进程内切会话，防旧任务在新会话触发）', () => {
    // P0 同源：CronScheduler 实例随 App 存活，sessionId 原为 readonly。切会话不重绑则旧任务
    // 留在内存 tick 到点照常 fire（旧会话 cron prompt 灌进新会话），且新任务被打旧 sessionId 下次加载不到。
    const fired: string[] = [];
    const sched = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-A', 100);
    sched.create('* * * * *', 'A 的旧任务');
    expect(sched.list()).toHaveLength(1);

    sched.rebindSession('session-B');
    expect(sched.list()).toHaveLength(0); // 旧任务已清
    const newJob = sched.create('* * * * *', 'B 的新任务');
    expect(newJob.sessionId).toBe('session-B'); // 新任务带新 sessionId

    sched.stop();
    expect(fired).toHaveLength(0);
  });
});

describe('cron 工具', () => {
  it('cron_create 创建，cron_list 列出', async () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const ctx = { cwd: process.cwd(), cron: sched };
    const c = await cronCreateTool.execute({ cron: '0 9 * * *', prompt: '早上提醒' }, ctx);
    expect(c.isError).toBe(false);
    expect(c.content).toContain('已创建定时任务');
    const l = await cronListTool.execute({}, ctx);
    expect(l.content).toContain('0 9 * * *'); // cron 表达式在列表里
    sched.stop();
  });

  it('ctx 无 cron 报不支持', async () => {
    const r = await cronCreateTool.execute({ cron: '* * * * *', prompt: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });
});
