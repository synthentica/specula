// Brand neutralization: spec/ never names the original product, so its names become "app".

/** Returns a function that replaces brand names in every string and object key of a JSON value. */
export function neutralizer(brand: string[] | undefined): <T>(value: T) => T {
  if (!brand?.length) return (value) => value;
  const pattern = new RegExp(brand.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const word = (match: string) => (match === match.toUpperCase() ? 'APP' : match[0] === match[0]!.toUpperCase() ? 'App' : 'app');
  // Hosts that carry the brand (static.brand.org) are not ours to point at: they become example.invalid.
  const host = new RegExp(`(https?://)([\\w.-]*(?:${pattern.source})[\\w.-]*)`, 'gi');
  const text = (s: string) => s.replace(host, '$1example.invalid').replace(pattern, word);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return <T>(value: T) => walk(value) as T;
}
