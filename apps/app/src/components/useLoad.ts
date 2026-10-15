// Asks a machine for something, checks the answer's shape, and asks again every `every` ms while
// the screen is in front (a running task's changes, say). Stale answers never overwrite newer ones.

import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ZodType } from 'zod'
import { hub } from '../app-state'
import type { RequestBody } from '../lib/hub'
import { UNREADABLE } from '../lib/results'

export interface Loaded<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** `body` null: nothing to ask yet. `key` changes when the question does. */
export function useLoad<T>(machine: string | undefined, body: RequestBody | null, schema: ZodType<T>, key: string, o: { every?: number; timeoutMs?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)
  const bodyRef = useRef(body)
  bodyRef.current = body

  const load = useCallback(async () => {
    const b = bodyRef.current
    if (!machine || !b) return
    const n = ++asked.current
    setLoading(true)
    const r = await hub.request(machine, b, { timeoutMs: o.timeoutMs ?? 15_000 })
    if (n !== asked.current) return
    setLoading(false)
    if (!r.ok) {
      setError(r.error ?? 'It didn’t load.')
      return
    }
    const parsed = schema.safeParse(r.data)
    if (!parsed.success) {
      setError(UNREADABLE)
      return
    }
    setError(null)
    setData(parsed.data)
  }, [machine, schema, o.timeoutMs])

  // A new question: forget the old answer.
  useEffect(() => {
    setData(null)
    setError(null)
    void load()
  }, [key, load])

  useFocusEffect(
    useCallback(() => {
      if (!o.every) return
      const timer = setInterval(() => void load(), o.every)
      return () => clearInterval(timer)
    }, [o.every, load]),
  )

  return { data, error, loading, reload: () => void load() }
}
