import { migrateTables, migrateWaterQuality } from './waterquality/migrate'
import { CHECKLIST_KEY } from './waterquality/domain'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import type { QualityCheckItem } from './waterquality/types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS) as Record<string, EntryRow[]>
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrateTables(fallback) as Record<string, EntryRow[]>
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = migrateTables(fallback) as Record<string, EntryRow[]>
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 历史浏览器数据缺字段时，迁移在进入缓存前补齐；新表里没有的表（如核查清单）仍取种子。
    const merged = migrateTables({ ...fallback, ...parsed })
    return merged as Record<string, EntryRow[]>
  } catch {
    const seeded = migrateTables(fallback) as Record<string, EntryRow[]>
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/**
 * 多表事务性落库：先在内存里拼好全部目标表，再统一序列化。
 * 序列化（或 localStorage 写入）一旦失败，缓存保持原状——报告和核查项要么一起生效，要么一起回退。
 */
export function commitTables(updates: Record<string, EntryRow[]>): void {
  const before = allRows()
  const target: Record<string, EntryRow[]> = { ...before, ...updates }
  // 先序列化：配额超限等异常会在这里抛出，此时缓存一行都还没动。
  const serialized = JSON.stringify(target)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 直接写正式键：若 setItem 抛异常（如配额不足），缓存依旧指向 before，读到的仍是旧值。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = target
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitTables({ [key]: rows })
}

/** 重置水质模块时报告和核查清单必须一起回到种子数据，避免清单残留。 */
export function resetWaterQuality(): EntryRow[] {
  const reports = clone(SEED_ROWS.waterquality ?? [])
  const migrated = migrateWaterQuality(reports, [] as QualityCheckItem[])
  commitTables({
    waterquality: migrated.reports,
    [CHECKLIST_KEY]: migrated.checklist,
  })
  return migrated.reports
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
