import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AchievementSnapshotWriter, achievementSnapshotsDir } from './achievement-snapshots';
const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'nexus-snap-')), 'a');
const item = (id: string, patch = {}) => ({ id, name: id, description: 'd', state: 'locked', secret: false, revoked: false, gamerscore: 10, ...patch }) as never;
const read = (d: string, name: string) => JSON.parse(readFileSync(path.join(d, name), 'utf8'));
it('resolves default and overridden directory', () => {
  expect(achievementSnapshotsDir({ HOME: '/h' })).toBe('/h/.local/share/nexus-launcher/achievements');
  expect(achievementSnapshotsDir({ HOME: '/h', NEXUS_ACHIEVEMENTS_DIR: '/x' })).toBe('/x');
  expect(achievementSnapshotsDir({ HOME: '/h', NEXUS_ACHIEVEMENTS_DIR: 'rel' })).toBe('/h/.local/share/nexus-launcher/achievements');
});
it('writes private title snapshot and index including locked items', async () => {
  const d = dir(), writer = new AchievementSnapshotWriter(d, () => 7);
  const items = [item('a', { state: 'unlocked', unlockedAt: '2024-01-02T03:04:05Z', progress: 100, iconUrl: 'https://images-eds-ssl.xboxlive.com/i' }),
    item('b', { secret: true, description: '', progress: 40, iconUrl: 'http://evil/x', name: 'B\nB' }), item('a')];
  expect(await writer.record('123', 'Game\x00', { status: 'available', items })).toBe(true);
  const title = read(d, '123.json');
  expect(title).toEqual({ version: 1, titleId: '123', titleName: 'Game', updatedAt: 7, achievements: [
    { id: 'a', name: 'a', description: 'd', gamerscore: 10, iconUrl: 'https://images-eds-ssl.xboxlive.com/i', unlocked: true, unlockedAt: Date.parse('2024-01-02T03:04:05Z'), progress: null, secret: false },
    { id: 'b', name: 'B B', description: '', gamerscore: 10, iconUrl: '', unlocked: false, unlockedAt: null, progress: 40, secret: true }] });
  expect(read(d, 'index.json')).toEqual({ version: 1, updatedAt: 7, titles: [{ titleId: '123', titleName: 'Game', unlocked: 1, total: 2, gamerscore: 10, gamerscoreTotal: 20, updatedAt: 7 }] });
  expect(statSync(d).mode & 0o777).toBe(0o700);
  expect(statSync(path.join(d, '123.json')).mode & 0o777).toBe(0o600);
  expect(statSync(path.join(d, 'index.json')).mode & 0o777).toBe(0o600);
  expect(readdirSync(d).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
it('ignores unavailable results and invalid title ids', async () => {
  const d = dir(), writer = new AchievementSnapshotWriter(d);
  expect(await writer.record('1', 'G', { status: 'error' })).toBe(false);
  expect(await writer.record('abc', 'G', { status: 'available', items: [] })).toBe(false);
  expect(() => readdirSync(d)).toThrow();
});
it('native unlock flips the entry, bumps counts and survives a restart', async () => {
  const d = dir(); let t = 1;
  const writer = new AchievementSnapshotWriter(d, () => t);
  expect(await writer.unlock('9', 'a')).toBe(false);
  await writer.record('9', 'Nine', { status: 'available', items: [item('a'), item('b')] });
  t = 50; expect(await writer.unlock('9', 'a')).toBe(true);
  expect(read(d, '9.json').achievements[0]).toMatchObject({ unlocked: true, unlockedAt: 50, progress: null });
  expect(read(d, 'index.json').titles[0]).toMatchObject({ unlocked: 1, gamerscore: 10, updatedAt: 50 });
  const next = new AchievementSnapshotWriter(d, () => 60);
  await next.record('2', 'Two', { status: 'available', items: [item('x')] });
  expect(read(d, 'index.json').titles.map((entry: { titleId: string }) => entry.titleId).sort()).toEqual(['2', '9']);
});
