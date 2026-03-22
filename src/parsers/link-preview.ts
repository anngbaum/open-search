import bplist from 'bplist-parser';

export interface DecodedLinkMetadata {
  originalURL: string | null;
  canonicalURL: string | null;
  title: string | null;
  summary: string | null;
  itemType: string | null;
  author: string | null;
}

interface UID {
  UID: number;
}

function isUID(val: unknown): val is UID {
  return typeof val === 'object' && val !== null && 'UID' in val;
}

/**
 * Resolve a value from the NSKeyedArchiver $objects array.
 * UIDs are references to other objects; strings resolve directly.
 */
function resolveValue(objects: unknown[], val: unknown): unknown {
  if (isUID(val)) return objects[val.UID];
  return val;
}

/**
 * Resolve a UID to a string. Handles both direct string refs
 * and NSURL objects (which have NS.relative -> UID -> string).
 */
function resolveString(objects: unknown[], val: unknown): string | null {
  const resolved = resolveValue(objects, val);
  if (typeof resolved === 'string') return resolved;
  return null;
}

function resolveURL(objects: unknown[], val: unknown): string | null {
  if (!isUID(val)) return typeof val === 'string' ? val : null;

  const obj = objects[val.UID];
  if (typeof obj === 'string') return obj;

  // NSURL: { NS.relative: UID -> string, NS.base: UID }
  if (obj && typeof obj === 'object' && 'NS.relative' in obj) {
    const relRef = (obj as Record<string, unknown>)['NS.relative'];
    return resolveString(objects, relRef);
  }

  return null;
}

/**
 * Decode an NSKeyedArchiver-encoded LPLinkMetadata bplist.
 *
 * Structure: $objects[2] is the LPLinkMetadata dict.
 * URLs are NSURL objects with NS.relative pointing to the string.
 */
export function decodeLinkPayload(payloadData: Buffer): DecodedLinkMetadata | null {
  try {
    const parsed = bplist.parseBuffer(payloadData);
    if (!parsed?.[0]?.['$objects']) return null;

    const objects: unknown[] = parsed[0]['$objects'];
    const metadata = objects[2];
    if (!metadata || typeof metadata !== 'object') return null;

    const meta = metadata as Record<string, unknown>;

    return {
      originalURL: resolveURL(objects, meta.originalURL),
      canonicalURL: resolveURL(objects, meta.URL),
      title: resolveString(objects, meta.title),
      summary: resolveString(objects, meta.summary),
      itemType: resolveString(objects, meta.itemType),
      author: resolveString(objects, meta.creatorFacebookProfile),
    };
  } catch {
    return null;
  }
}
