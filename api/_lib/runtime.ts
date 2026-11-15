/** Module-level singletons so key cooldowns survive between warm invocations. */
import { loadSettings, type Settings } from "./env.js";
import { KeyPool } from "./keys.js";

export interface Runtime {
  settings: Settings;
  firecrawl: KeyPool;
  gemini: KeyPool;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const settings = loadSettings();
  runtime = {
    settings,
    firecrawl: new KeyPool(settings.firecrawlKeys, "Firecrawl"),
    gemini: new KeyPool(settings.geminiKeys, "Gemini"),
  };
  return runtime;
}

export function resetRuntime(): void {
  runtime = null;
}
