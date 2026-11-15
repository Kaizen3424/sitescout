/**
 * Pool of API keys with random selection, cooldowns and dead-key tracking.
 * Mirrors the Python `keypool.py`. Instances live at module scope, so their
 * state survives between requests on a warm function instance.
 */
import { ConfigError, FatalApiError } from "./errors.js";

interface KeyState {
  fails: number;
  cooldownUntil: number;
  dead: boolean;
}

export class KeyPool {
  readonly keys: string[];
  readonly name: string;
  private readonly state = new Map<string, KeyState>();

  constructor(keys: string[], name: string) {
    this.name = name;
    this.keys = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
    if (this.keys.length === 0) {
      throw new ConfigError(`No ${name} API keys configured.`);
    }
    for (const key of this.keys) {
      this.state.set(key, { fails: 0, cooldownUntil: 0, dead: false });
    }
  }

  get size(): number {
    return this.keys.length;
  }

  /** Random healthy key not in `exclude`. Throws when none is available. */
  pick(exclude: Set<string> = new Set()): string {
    const now = Date.now();
    const alive = this.keys.filter((k) => !exclude.has(k) && !this.state.get(k)?.dead);
    if (alive.length === 0) {
      throw new FatalApiError(
        `All ${this.name} API keys are invalid or exhausted. Add more keys to ` +
          `${this.name.toUpperCase()}_API_KEYS.`,
      );
    }
    const ready = alive.filter((k) => (this.state.get(k)?.cooldownUntil ?? 0) <= now);
    const candidates = ready.length > 0 ? ready : alive;
    return candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  hasAlive(): boolean {
    return this.keys.some((k) => !this.state.get(k)?.dead);
  }

  /** Milliseconds until the soonest cooling key is ready; null when all are dead. */
  msUntilReady(): number | null {
    const alive = this.keys.filter((k) => !this.state.get(k)?.dead);
    if (alive.length === 0) return null;
    const soonest = Math.min(...alive.map((k) => this.state.get(k)?.cooldownUntil ?? 0));
    return Math.max(0, soonest - Date.now());
  }

  reportSuccess(key: string): void {
    const st = this.state.get(key);
    if (!st) return;
    st.fails = 0;
    st.cooldownUntil = 0;
  }

  /** 429: rate-limit windows are usually about a minute, so no exponential growth. */
  reportRateLimited(key: string, cooldownMs = 60_000): void {
    const st = this.state.get(key);
    if (!st) return;
    st.fails += 1;
    st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + cooldownMs);
  }

  reportFailure(key: string, opts: { fatal?: boolean; cooldownMs?: number } = {}): void {
    const st = this.state.get(key);
    if (!st) return;
    st.fails += 1;
    if (opts.fatal) {
      st.dead = true;
      return;
    }
    const base = opts.cooldownMs ?? 30_000;
    const backoff = Math.min(base * 2 ** (st.fails - 1), 600_000);
    st.cooldownUntil = Date.now() + backoff;
  }

  summary(): { total: number; alive: number; ready: number } {
    const now = Date.now();
    return {
      total: this.keys.length,
      alive: this.keys.filter((k) => !this.state.get(k)?.dead).length,
      ready: this.keys.filter(
        (k) => !this.state.get(k)?.dead && (this.state.get(k)?.cooldownUntil ?? 0) <= now,
      ).length,
    };
  }
}
