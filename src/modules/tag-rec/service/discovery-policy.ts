import type { TagRecLadderSettings } from '../model/filter-engine'

export function tagRecDiscoveryPolicy(settings: Partial<TagRecLadderSettings> = {}) {
  const number = (value: number | undefined, fallback: number, min: number, max: number) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.round(value)))
  return {
    mode: settings.mode === 'fixed' ? ('fixed' as const) : ('adaptive' as const),
    autoDigMax: number(settings.autoDigMax, 3, 1, 20),
    lowYield: number(settings.lowYield, 3, 1, 50),
    lowYieldStreakLimit: number(settings.lowYieldStreakLimit, 2, 1, 20),
    emptyTtlMinutes: number(settings.emptyTtlMinutes, 60, 5, 1440),
  }
}
