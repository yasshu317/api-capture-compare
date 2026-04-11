export interface AuditComparison {
  originalStatus: number | null;
  newStatus:      number | null;
  statusMatch:    boolean;

  originalKeys:   string[];
  newKeys:        string[];
  missingKeys:    string[];   // in original but not in new
  extraKeys:      string[];   // in new but not in original
  keysMatch:      boolean;

  originalCount:  number | null;
  newCount:       number | null;
  countMatch:     boolean | null;   // null when neither response has countable rows

  error?:         string;
}

const ROW_FIELDS = ['data', 'items', 'results', 'rows', 'list', 'content', 'records', 'payload', 'entries'];
const COUNT_FIELDS = ['total', 'count', 'totalCount', 'totalRows', 'recordCount', 'size'];

function extractTopLevelKeys(body: unknown): string[] {
  if (body === null || body === undefined) return [];
  if (Array.isArray(body)) {
    if (body.length > 0 && body[0] !== null && typeof body[0] === 'object') {
      return Object.keys(body[0] as Record<string, unknown>).sort();
    }
    return [];
  }
  if (typeof body === 'object') {
    return Object.keys(body as Record<string, unknown>).sort();
  }
  return [];
}

function countRows(body: unknown): number | null {
  if (body === null || body === undefined) return null;

  // Top-level array
  if (Array.isArray(body)) return body.length;

  if (typeof body === 'object') {
    const record = body as Record<string, unknown>;

    // Common numeric count/total fields
    for (const key of COUNT_FIELDS) {
      if (typeof record[key] === 'number') return record[key] as number;
    }

    // Common array container fields
    for (const key of ROW_FIELDS) {
      if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
    }
  }
  return null;
}

export function auditCompare(
  originalStatus: number | null,
  originalBody: unknown,
  newStatus: number | null,
  newBody: unknown,
  error?: string,
): AuditComparison {
  const originalKeys = extractTopLevelKeys(originalBody);
  const newKeys      = extractTopLevelKeys(newBody);

  const originalSet  = new Set(originalKeys);
  const newSet       = new Set(newKeys);
  const missingKeys  = originalKeys.filter((k) => !newSet.has(k));
  const extraKeys    = newKeys.filter((k) => !originalSet.has(k));

  const originalCount = countRows(originalBody);
  const newCount      = countRows(newBody);
  const countMatch    = (originalCount !== null && newCount !== null)
    ? originalCount === newCount
    : null;

  return {
    originalStatus,
    newStatus,
    statusMatch:   originalStatus === newStatus,
    originalKeys,
    newKeys,
    missingKeys,
    extraKeys,
    keysMatch:     missingKeys.length === 0 && extraKeys.length === 0,
    originalCount,
    newCount,
    countMatch,
    error,
  };
}
