export interface AuditComparison {
  originalStatus: number | null;
  newStatus:      number | null;
  statusMatch:    boolean;

  // Flat dot-path list of every key found anywhere in the response tree
  // e.g. ["data", "data.items", "data.items.id", "data.items.name", "meta.total"]
  originalKeys: string[];
  newKeys:      string[];
  missingKeys:  string[]; // paths in original but NOT in new
  extraKeys:    string[]; // paths in new but NOT in original
  keysMatch:    boolean;

  originalCount: number | null;
  newCount:      number | null;
  countBasis:    string | null;  // what was counted, e.g. '"total" field', 'object key count'
  countMatch:    boolean | null;

  error?: string;
}

// ─── nested key extraction ────────────────────────────────────────────────────

const MAX_DEPTH   = 10;   // prevent runaway recursion on deep objects
const SAMPLE_SIZE =  3;   // how many array items to union-sample for keys

/**
 * Recursively extract every dot-path key from a JSON value.
 * Arrays are sampled (first SAMPLE_SIZE items) so all possible keys are found
 * even when items have different shapes.
 */
function extractKeys(value: unknown, prefix = '', depth = 0): string[] {
  if (depth > MAX_DEPTH) return prefix ? [prefix] : [];
  if (value === null || value === undefined) return prefix ? [prefix] : [];

  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [prefix] : [];

    // Union keys across the first few items so sparse fields are not missed
    const set = new Set<string>();
    const sample = value.slice(0, SAMPLE_SIZE);
    for (const item of sample) {
      for (const k of extractKeys(item, prefix, depth)) set.add(k);
    }
    return [...set];
  }

  if (typeof value === 'object') {
    const keys: string[] = [];
    if (prefix) keys.push(prefix); // record the object itself as a key
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      keys.push(...extractKeys(v, path, depth + 1));
    }
    return keys;
  }

  // Scalar leaf — just record the path
  return prefix ? [prefix] : [];
}

function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

// ─── row / size counting ──────────────────────────────────────────────────────
//
// Priority order:
//   1. Explicit numeric count field   (total, count, totalCount, …)
//   2. Known array container field    (data, items, results, …)  → array length
//   3. Top-level array                → array length
//   4. Top-level object               → number of keys  (always gives something to compare)
//   5. Anything else                  → null
//
// The "basis" string is returned alongside the number so the report can say
// e.g. "6 keys (object size)" vs "12 records (items array)".

export interface CountResult {
  value: number;
  basis: string; // human-readable explanation of what was counted
}

const ROW_FIELDS   = ['data', 'items', 'results', 'rows', 'list', 'content', 'records', 'payload', 'entries'];
const COUNT_FIELDS = ['total', 'count', 'totalCount', 'totalRows', 'recordCount', 'size', 'totalResults', 'total_count'];

function countRows(body: unknown): CountResult | null {
  if (body === null || body === undefined) return null;

  // 1. Top-level array
  if (Array.isArray(body)) return { value: body.length, basis: 'top-level array' };

  if (typeof body === 'object') {
    const rec = body as Record<string, unknown>;

    // 2. Explicit numeric count field
    for (const k of COUNT_FIELDS) {
      if (typeof rec[k] === 'number') return { value: rec[k] as number, basis: `"${k}" field` };
    }

    // 3. Known array container
    for (const k of ROW_FIELDS) {
      if (Array.isArray(rec[k])) return { value: (rec[k] as unknown[]).length, basis: `"${k}" array` };
    }

    // 4. Fall back to key count — always gives a number to compare
    const keyCount = Object.keys(rec).length;
    return { value: keyCount, basis: 'object key count' };
  }

  return null;
}

// ─── main compare ─────────────────────────────────────────────────────────────

export function auditCompare(
  originalStatus: number | null,
  originalBody:   unknown,
  newStatus:      number | null,
  newBody:        unknown,
  error?:         string,
): AuditComparison {
  const originalKeys = uniqueSorted(extractKeys(originalBody));
  const newKeys      = uniqueSorted(extractKeys(newBody));

  const origSet = new Set(originalKeys);
  const newSet  = new Set(newKeys);

  const missingKeys = originalKeys.filter((k) => !newSet.has(k));
  const extraKeys   = newKeys.filter((k) => !origSet.has(k));

  const origCount = countRows(originalBody);
  const nwCount   = countRows(newBody);

  const originalCount = origCount?.value ?? null;
  const newCount      = nwCount?.value   ?? null;
  // Use whichever basis description is available (prefer original)
  const countBasis    = origCount?.basis ?? nwCount?.basis ?? null;
  const countMatch    = (originalCount !== null && newCount !== null)
    ? originalCount === newCount
    : null;

  return {
    originalStatus,
    newStatus,
    statusMatch: originalStatus === newStatus,
    originalKeys,
    newKeys,
    missingKeys,
    extraKeys,
    keysMatch: missingKeys.length === 0 && extraKeys.length === 0,
    originalCount,
    newCount,
    countBasis,
    countMatch,
    error,
  };
}
