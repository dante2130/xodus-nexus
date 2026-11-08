import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeAchievementIcon } from './game-achievements.js';

export interface AchievementEvent { titleId: string; scid: string; id: string; name: string; description: string; gamerscore: number; iconUrl: string; }
const MAX_FILE_BYTES = 1_000_000, MAX_SEEN = 4096;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';

export function achievementEventsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.NEXUS_ACHIEVEMENT_EVENTS;
  if (override && path.isAbsolute(override)) return override;
  return path.join(environment.HOME || os.homedir(), '.local/share/nexus-launcher/achievement-events.jsonl');
}

/** Append-only JSONL feed for external notifiers (e.g. a Decky plugin). Deduped per title and achievement. */
export class AchievementEventWriter {
  private seen = new Set<string>();
  private native = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file = achievementEventsPath(), private now = Date.now) {}
  /** True once the game itself reported an unlock for this title, which makes polling redundant. */
  hasNative(titleId: string): boolean { return this.native.has(titleId); }
  emit(input: AchievementEvent, source: 'game' | 'poll' = 'game'): Promise<boolean> {
    const event = {
      titleId: clean(input.titleId, 20), scid: clean(input.scid, 64), id: clean(input.id, 180), name: clean(input.name, 256),
      description: clean(input.description, 1500), gamerscore: Number.isInteger(input.gamerscore) && input.gamerscore >= 0 && input.gamerscore <= 10_000 ? input.gamerscore : 0,
      iconUrl: safeAchievementIcon(clean(input.iconUrl, 2048)) ?? '',
    };
    if (!event.titleId || !event.id || !event.name) return Promise.resolve(false);
    const key = `${event.titleId}:${event.id}`;
    if (source === 'game') this.native.add(event.titleId);
    if (this.seen.has(key)) return Promise.resolve(false);
    if (this.seen.size >= MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(key);
    const line = JSON.stringify({ type: 'achievement', ts: this.now(), ...event }) + '\n';
    const job = this.queue.then(() => this.append(line)).then(() => true, () => false);
    this.queue = job;
    return job;
  }
  private async append(line: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try { if ((await fs.stat(this.file)).size >= MAX_FILE_BYTES) await fs.rename(this.file, this.file + '.1'); } catch { /* No file yet. */ }
    const handle = await fs.open(this.file, 'a', 0o600);
    try { await handle.appendFile(line); } finally { await handle.close(); }
  }
}
