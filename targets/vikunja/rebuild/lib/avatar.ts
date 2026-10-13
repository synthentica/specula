// Generated avatar: the first letters of the name on a colour derived from it.

import { createHash } from 'node:crypto';

const escapeXml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function avatarSvg(name: string, size: number): string {
  const digest = createHash('sha256').update(name).digest();
  const hue = (digest[0]! * 256 + digest[1]!) % 360;
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = escapeXml(((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="${escapeXml(name)}">
<rect width="100" height="100" rx="50" fill="hsl(${hue} 45% 42%)"/>
<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${initials.length > 1 ? 40 : 48}" font-weight="600" fill="#fff">${initials}</text>
</svg>`;
}
