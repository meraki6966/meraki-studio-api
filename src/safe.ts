/**
 * Checks on the few values a caller supplies that end up in a file path.
 * Each of these was joined into a path as given, so a value such as
 * "../../package" could read or write outside the data folder.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Project ids are made by uuidv4(). Anything else is not a project id. */
export function isProjectId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** A file extension: letters and digits only, 1 to 5 of them. Falls back to the default. */
export function safeExtension(value: unknown, fallback = 'mp4'): string {
  const ext = String(value ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : fallback;
}

/** A render name: letters, digits, hyphen and underscore, up to 80. Otherwise undefined, and the project id is used. */
export function safeOutputName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;
}
