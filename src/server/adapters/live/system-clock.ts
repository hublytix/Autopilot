import 'server-only';
import type { Clock } from '@/server/ports/clock';

/** The wall clock. The only module allowed to read it (D-28; enforced by the ESLint time-API ban). */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
