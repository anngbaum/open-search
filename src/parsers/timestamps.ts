// iMessage stores dates as nanoseconds since 2001-01-01 00:00:00 UTC
// (Core Data / Apple Cocoa epoch).
// Some older databases store seconds instead of nanoseconds.
// The threshold below distinguishes the two formats.

const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01
const NANOSECOND_THRESHOLD = 1e12; // values above this are nanoseconds

export function imessageDateToJS(timestamp: number | null): Date | null {
  if (timestamp == null || timestamp === 0) return null;

  let seconds: number;
  if (Math.abs(timestamp) > NANOSECOND_THRESHOLD) {
    // Nanoseconds since 2001-01-01
    seconds = timestamp / 1e9;
  } else {
    // Already in seconds since 2001-01-01
    seconds = timestamp;
  }

  const unixSeconds = seconds + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}
