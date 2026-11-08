import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GameAchievement, GameAchievements } from '../shared/types.js';
import { safeAchievementIcon } from './game-achievements.js';

export interface SnapshotAchievement { id: string; name: string; description: string; gamerscore: number; iconUrl: string; unlocked: boolean; unlockedAt: number | null; progress: number | null; secret: boolean; }
export interface TitleSnapshot { version: 1; titleId: string; titleName: string; updatedAt: number; achievements: SnapshotAchievement[]; }
export interface SnapshotIndexEntry { titleId: string; titleName: string; unlocked: number; total: number; gamerscore: number; gamerscoreTotal: number; updatedAt: number; }

const MAX_ITEMS = 500, MAX_INDEX = 500, MAX_FILE_BYTES = 4_000_000;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
const validTitle = (titleId: string) => /^[1-9]\d{0,9}$/.test(titleId) && Number(titleId) <= 0xffffffff;
const score = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000 ? Number(value) : 0;

export function achievementSnapshotsDir(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.NEXUS_ACHIEVEMENTS_DIR;
  if (override && path.isAbsolute(override)) return override;
  return path.join(environment.HOME || os.homedir(), '.local/share/nexus-launcher/achievements');
}

function fromBackend(item: GameAchievement): SnapshotAchievement {
  const unlocked = item.state === 'unlocked' && !item.revoked;
  const time = unlocked && item.unlockedAt ? Date.parse(item.unlockedAt) : NaN;
  return {
    id: clean(item.id, 180), name: clean(item.name, 256), description: clean(item.description, 1500),
    gamerscore: score(item.gamerscore), iconUrl: safeAchievementIcon(clean(item.iconUrl, 2048)) ?? '', unlocked,
    unlockedAt: Number.isFinite(time) ? time : null,
    progress: !unlocked && typeof item.progress === 'number' && Number.isFinite(item.progress) ? Math.min(100, Math.max(0, item.progress)) : null,
    secret: item.secret === true,
  };
}

function summarize(snapshot: TitleSnapshot): SnapshotIndexEntry {
  const unlocked = snapshot.achievements.filter(item => item.unlocked);
  return { titleId: snapshot.titleId, titleName: snapshot.titleName, unlocked: unlocked.length, total: snapshot.achievements.length,
    gamerscore: unlocked.reduce((sum, item) => sum + item.gamerscore, 0), gamerscoreTotal: snapshot.achievements.reduce((sum, item) => sum + item.gamerscore, 0), updatedAt: snapshot.updatedAt };
}

/** Per-title JSON snapshots (locked included) plus an index, for external readers such as a Decky plugin. */
export class AchievementSnapshotWriter {
  private titles = new Map<string, TitleSnapshot>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private dir = achievementSnapshotsDir(), private now = Date.now) {}

  /** Replace a title's snapshot from a successful backend read. Other statuses leave existing data untouched. */
  record(titleId: string, titleName: string, value: GameAchievements): Promise<boolean> {
    if (value.status !== 'available' || !value.items || !validTitle(titleId)) return Promise.resolve(false);
    const name = clean(titleName, 256);
    if (!name) return Promise.resolve(false);
    const seen = new Set<string>();
    const achievements = value.items.slice(0, MAX_ITEMS).map(fromBackend).filter(item => item.id && item.name && !seen.has(item.id) && seen.add(item.id));
    return this.enqueue(async () => {
      await this.load();
      await this.save({ version: 1, titleId, titleName: name, updatedAt: this.now(), achievements });
    });
  }

  /** Mark one achievement unlocked after a native in-game event; needs an existing snapshot to bump. */
  unlock(titleId: string, id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.load();
      const current = this.titles.get(titleId);
      const item = current?.achievements.find(entry => entry.id === clean(id, 180));
      if (!current || !item) return false;
      if (!item.unlocked) { item.unlocked = true; item.unlockedAt = this.now(); item.progress = null; }
      await this.save({ ...current, updatedAt: this.now() });
      return true;
    });
  }

  private enqueue(job: () => Promise<boolean | void>): Promise<boolean> {
    const next = this.queue.then(job).then(result => result !== false, () => false);
    this.queue = next;
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const names = (await fs.readdir(this.dir)).filter(name => /^[1-9]\d{0,9}\.json$/.test(name)).slice(0, MAX_INDEX);
      for (const name of names) {
        try {
          const file = path.join(this.dir, name);
          if ((await fs.stat(file)).size > MAX_FILE_BYTES) continue;
          const value = JSON.parse(await fs.readFile(file, 'utf8')) as TitleSnapshot;
          if (value?.version === 1 && `${value.titleId}.json` === name && Array.isArray(value.achievements)) this.titles.set(value.titleId, value);
        } catch { /* Skip unreadable snapshots; they are rewritten on the next refresh. */ }
      }
    } catch { /* No snapshots yet. */ }
  }

  private async save(snapshot: TitleSnapshot): Promise<void> {
    this.titles.set(snapshot.titleId, snapshot);
    if (this.titles.size > MAX_INDEX) this.titles.delete([...this.titles.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0].titleId);
    await this.atomic(`${snapshot.titleId}.json`, snapshot);
    const entries = [...this.titles.values()].map(summarize).sort((a, b) => a.titleName.localeCompare(b.titleName));
    await this.atomic('index.json', { version: 1, updatedAt: this.now(), titles: entries });
  }

  private async atomic(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700).catch(() => {});
    const target = path.join(this.dir, name), temp = `${target}.${process.pid}.${this.now()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temp, target);
    } catch (error) { await fs.rm(temp, { force: true }); throw error; }
  }
}
