import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AchievementEventWriter, achievementEventsPath } from './achievement-events';
import { AchievementUnlockWatcher } from './game-achievements';
import { GameInviteBridge } from './game-invite-bridge';
const ev = (patch = {}) => ({ titleId: '123', scid: 's', id: 'a1', name: 'First', description: 'Do it', gamerscore: 10, iconUrl: 'https://images-eds-ssl.xboxlive.com/i', ...patch });
const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'nexus-ach-')), 'sub', 'events.jsonl');
it('resolves the default and overridden event path', () => {
  expect(achievementEventsPath({ HOME: '/h' })).toBe('/h/.local/share/nexus-launcher/achievement-events.jsonl');
  expect(achievementEventsPath({ HOME: '/h', NEXUS_ACHIEVEMENT_EVENTS: '/x/e.jsonl' })).toBe('/x/e.jsonl');
  expect(achievementEventsPath({ HOME: '/h', NEXUS_ACHIEVEMENT_EVENTS: 'rel' })).toBe('/h/.local/share/nexus-launcher/achievement-events.jsonl');
});
it('writes private deduped JSONL and strips unsafe fields', async () => {
  const file = dir(), writer = new AchievementEventWriter(file, () => 5);
  expect(await writer.emit(ev({ name: 'A\nB', iconUrl: 'http://evil/x' }))).toBe(true);
  expect(await writer.emit(ev())).toBe(false);
  expect(await writer.emit(ev({ id: 'a2' }))).toBe(true);
  const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEqual({ type: 'achievement', ts: 5, titleId: '123', scid: 's', id: 'a1', name: 'A B', description: 'Do it', gamerscore: 10, iconUrl: '' });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});
it('rotates large files', async () => {
  const file = dir(), writer = new AchievementEventWriter(file);
  await writer.emit(ev()); writeFileSync(file, 'x'.repeat(1_000_001));
  await writer.emit(ev({ id: 'b' }));
  expect(existsSync(file + '.1')).toBe(true); expect(readFileSync(file, 'utf8')).toContain('"id":"b"');
});
it('watcher seeds baseline then reports only new unlocks', () => {
  const item = (id: string, state = 'unlocked') => ({ id, name: id, description: '', state, secret: false, revoked: false }) as never;
  const watcher = new AchievementUnlockWatcher();
  expect(watcher.diff('1', { status: 'available', items: [item('a'), item('b', 'locked')] })).toEqual([]);
  expect(watcher.diff('1', { status: 'error' })).toEqual([]);
  expect(watcher.diff('1', { status: 'available', items: [item('a'), item('b')] }).map(value => value.id)).toEqual(['b']);
  expect(watcher.diff('1', { status: 'available', items: [item('a'), item('b')] })).toEqual([]);
});
it('bridge relays bound achievement-unlocked messages', () => {
  const seen: unknown[] = [], bridge = new GameInviteBridge('o', 'G', '123', () => true, () => {}, () => {}, () => 1000, () => {}, undefined, event => seen.push(event));
  const msg = ['achievement-unlocked', '123', 's', 'a1', 'Name', 'Desc', '10', ''];
  expect(bridge.exchange(msg)[0]).not.toBe(0);
  bridge.exchange(['hello', '42', '123']);
  expect(bridge.exchange(['achievement-unlocked', '124', ...msg.slice(2)])[0]).not.toBe(0);
  expect(bridge.exchange(msg)[0]).toBe(0);
  expect(seen).toEqual([{ titleId: '123', scid: 's', id: 'a1', name: 'Name', description: 'Desc', gamerscore: 10, iconUrl: '' }]);
});
