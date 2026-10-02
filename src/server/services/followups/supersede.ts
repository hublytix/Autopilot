import 'server-only';

// D-44's dynamic stop. The SQL lives in services/notifications/supersede.ts (the follow_up
// reservation predicate's module), so the two service directories never import each other in a cycle.
export { isSuperseded, supersededSql } from '@/server/services/notifications/supersede';
