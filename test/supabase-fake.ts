/**
 * Minimal chainable Supabase query fake for route tests.
 *
 * Every `from(table)...` chain is recorded as a FakeQuery and resolved by the
 * handler you pass in, so a test only describes the rows it cares about.
 */

export type FakeOp = "select" | "insert" | "update" | "delete" | "upsert"

export interface FakeQuery {
  table: string
  op: FakeOp
  payload?: unknown
  columns?: string
  options?: unknown
  filters: Record<string, unknown>
  single: boolean
}

export interface FakeResult {
  data?: unknown
  error?: unknown
  count?: number | null
}

export type FakeHandler = (q: FakeQuery) => FakeResult | void | Promise<FakeResult | void>

export interface FakeUser {
  id: string
  email?: string
}

export function fakeSupabase(handler: FakeHandler = () => ({}), user: FakeUser | null = null) {
  const queries: FakeQuery[] = []

  function from(table: string) {
    const q: FakeQuery = { table, op: "select", filters: {}, single: false }
    const builder = {
      select(columns?: string, options?: unknown) {
        if (q.op === "select") {
          q.columns = columns
          q.options = options
        }
        return builder
      },
      insert(payload: unknown) {
        q.op = "insert"
        q.payload = payload
        return builder
      },
      upsert(payload: unknown, options?: unknown) {
        q.op = "upsert"
        q.payload = payload
        q.options = options
        return builder
      },
      update(payload: unknown) {
        q.op = "update"
        q.payload = payload
        return builder
      },
      delete() {
        q.op = "delete"
        return builder
      },
      eq(column: string, value: unknown) {
        q.filters[column] = value
        return builder
      },
      order() {
        return builder
      },
      limit() {
        return builder
      },
      single() {
        q.single = true
        return builder
      },
      maybeSingle() {
        q.single = true
        return builder
      },
      then<T1, T2>(
        onFulfilled?: (v: { data: unknown; error: unknown; count: number | null }) => T1,
        onRejected?: (e: unknown) => T2,
      ) {
        queries.push(q)
        return Promise.resolve(handler(q))
          .then((r) => ({ data: r?.data ?? null, error: r?.error ?? null, count: r?.count ?? null }))
          .then(onFulfilled, onRejected)
      },
    }
    return builder
  }

  const client = {
    from,
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
    },
  }

  return { client, queries }
}
