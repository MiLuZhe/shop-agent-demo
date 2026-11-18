const colors = [
  ['#e2eee7','#21483d'], ['#e5e9f8','#344a86'], ['#f4e5ee','#82395e'], ['#f7ead8','#825a24'],
  ['#eae4f6','#62418c'], ['#dfedf2','#2a6277'], ['#eee9dd','#685b35'], ['#f3e3df','#843f32'],
] as const;
export function Avatar({ username, large = false }: { username: string; large?: boolean }) {
  let hash = 2166136261;
  for (const char of username) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  const [background, color] = colors[(hash >>> 0) % colors.length]!;
  return <span className={`user-avatar${large ? ' user-avatar-large' : ''}`} style={{ backgroundColor: background, color }} aria-hidden="true">{Array.from(username)[0]?.toUpperCase() ?? '?'}</span>;
}
