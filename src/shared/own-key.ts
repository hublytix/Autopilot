// Looks a request-supplied code (a `?error=` or `?result=` query value) up in a message table by
// own keys only: a plain object literal also "has" `constructor`, `toString` and the rest of
// Object.prototype, which must never reach a page as if they were messages.
export function ownValue<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}
