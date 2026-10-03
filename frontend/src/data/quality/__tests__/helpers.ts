// 内存版持久化，供 Node 单测使用，模拟 localStorage 与写入失败。
export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  let failTimes = 0
  return {
    getItem(key: string): string | null {
      return data.has(key) ? (data.get(key) as string) : null
    },
    setItem(key: string, value: string): void {
      if (failTimes > 0) {
        failTimes -= 1
        throw new Error('存储不可用（注入故障）')
      }
      data.set(key, value)
    },
    removeItem(key: string): void {
      data.delete(key)
    },
    failNextWrite(times = 1): void {
      failTimes = times
    },
    dump(key: string): unknown {
      const raw = data.get(key)
      return raw ? JSON.parse(raw) : null
    },
    has(key: string): boolean {
      return data.has(key)
    },
  }
}

export const fixedClock = { now: () => '2026-10-03 09:00' }
