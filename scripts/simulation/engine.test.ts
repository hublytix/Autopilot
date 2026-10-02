import { describe, expect, it } from 'vitest';
import { FakeClock } from '@/server/adapters/fake/clock';
import { FakeScheduler, type FakeDelivery } from '@/server/adapters/fake/scheduler';
import { DAILY_0317_UTC, EVERY_5_MINUTES, HOURLY, TimeTravel, type CronSeries } from './engine';

const START = new Date('2026-10-06T13:00:00.000Z');

function rig(dispatch: (delivery: FakeDelivery) => number = () => 200) {
  const clock = new FakeClock(START);
  const log: string[] = [];
  const at = (): string => clock.now().toISOString().slice(11, 19);
  const scheduler = new FakeScheduler({
    clock,
    dispatch: (delivery) => {
      log.push(`${at()} job ${delivery.jobId}#${delivery.retried}`);
      return dispatch(delivery);
    },
    onFailure: (failure) => {
      log.push(`${at()} failed ${failure.jobId}`);
    },
  });
  const series = (name: string, next: CronSeries['next']): CronSeries => ({
    name,
    next,
    run: async () => {
      log.push(`${at()} tick ${name}`);
    },
  });
  const travel = new TimeTravel({
    clock,
    scheduler,
    crons: [series('poll', EVERY_5_MINUTES), series('hourly', HOURLY), series('daily', DAILY_0317_UTC)],
  });
  return { clock, scheduler, travel, log, at };
}

describe('simulation time travel', () => {
  it('runs events, then due jobs, then ticks at the same instant, starting with the tick at the start instant', async () => {
    const { clock, scheduler, travel, log, at } = rig();
    travel.at(START, 'install', async () => {
      log.push(`${at()} event install`);
      await scheduler.publish({ jobId: 'a', kind: 'portal_poll', runAt: clock.now(), dedupeId: 'a', retries: 4 });
    });
    await travel.advanceTo(new Date('2026-10-06T13:10:00.000Z'));
    expect(log).toEqual([
      '13:00:00 event install',
      '13:00:00 job a#0',
      '13:00:00 tick poll',
      '13:00:00 tick hourly',
      '13:05:00 tick poll',
      '13:10:00 tick poll',
    ]);
    expect(clock.now().toISOString()).toBe('2026-10-06T13:10:00.000Z');
  });

  it('delivers retries on the QStash backoff and then the failure callback, in time order with the ticks', async () => {
    const { scheduler, travel, log } = rig(() => 500);
    await scheduler.publish({ jobId: 'b', kind: 'lead_process', runAt: new Date('2026-10-06T13:04:00.000Z'), dedupeId: 'b', retries: 4 });
    await travel.advanceTo(new Date('2026-10-06T13:06:00.000Z'));
    // Backoff 10 s, 20 s, 40 s, 80 s after each failed delivery (PLAN §4).
    expect(log).toEqual([
      '13:00:00 tick poll',
      '13:00:00 tick hourly',
      '13:04:00 job b#0',
      '13:04:10 job b#1',
      '13:04:30 job b#2',
      '13:05:00 tick poll',
      '13:05:10 job b#3',
    ]);
    await travel.advanceTo(new Date('2026-10-06T13:07:00.000Z'));
    expect(log.slice(-2)).toEqual(['13:06:30 job b#4', '13:06:30 failed b']);
  });

  it('fires the daily tick at 03:17 UTC and the hourly one on the hour', async () => {
    const { travel, log } = rig();
    await travel.advanceTo(new Date('2026-10-07T03:20:00.000Z'));
    expect(log.filter((line) => line.endsWith('daily'))).toEqual(['03:17:00 tick daily']);
    expect(log.filter((line) => line.endsWith('hourly'))).toHaveLength(15);
    expect(log.filter((line) => line.endsWith('poll'))).toHaveLength(14 * 12 + 4 + 1);
  });

  it('runs events added at the same instant in the order they were added, and refuses the past', async () => {
    const { travel, log, at } = rig();
    const later = new Date('2026-10-06T13:02:00.000Z');
    travel.at(later, 'first', async () => {
      log.push(`${at()} first`);
    });
    travel.at(later, 'second', async () => {
      log.push(`${at()} second`);
    });
    expect(travel.pendingEvents).toEqual(['first', 'second']);
    await travel.advanceTo(later);
    expect(log.slice(-2)).toEqual(['13:02:00 first', '13:02:00 second']);
    expect(() => travel.at(START, 'late', async () => undefined)).toThrow(RangeError);
    await expect(travel.advanceTo(START)).rejects.toThrow('cannot travel backwards');
  });
});
