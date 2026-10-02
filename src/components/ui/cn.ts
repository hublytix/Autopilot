/** Joins class names, skipping empty and falsy parts. */
export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}
