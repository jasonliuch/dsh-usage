import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { emptyTotals, type UsageDayView, type UsageOverviewView } from '../src/core/types.ts'
import type { UsageService } from '../src/host/usage-service.ts'
import { makeUsageDayRoute, makeUsageOverviewRoute, makeUsageRefreshRoute, USAGE_API_PREFIX } from '../src/host/routes.ts'

/**
 * Route-surface tests: the platform's admission decision, the POST-only
 * refresh method gate, and the JSON response contract. The service is a stub —
 * the service-level behaviors live in usage-service.spec.ts.
 */

/**
 * A host context whose `connection` service admits every request. The plugin
 * owns no fence of its own, so this double IS the trust decision under test.
 */
function admittingCtx(): never {
  return { connection: { requestRejection: () => undefined } } as never
}

/**
 * A host context whose `connection` service refuses with the given status.
 * @param status - the platform's rejection status (401 or 403).
 * @returns a host context double.
 */
function rejectingCtx(status: 401 | 403): never {
  return { connection: { requestRejection: () => status } } as never
}

const OVERVIEW: UsageOverviewView = {
  updatedAt: 1,
  providers: [],
  current: { source: 'default' },
  usage: { today: { date: '2026-08-29', totals: emptyTotals(), providers: [] }, days: [] },
}

const DAY: UsageDayView = {
  date: '2026-08-28',
  totals: { ...emptyTotals(), inputTokens: 120, outputTokens: 30, calls: 2 },
  providers: [{ provider: 'deepseek', totals: { ...emptyTotals(), inputTokens: 120, outputTokens: 30, calls: 2 }, models: [] }],
}

function stubService(overrides: Partial<Pick<UsageService, 'overview' | 'day' | 'refresh'>> = {}): UsageService {
  return { overview: () => OVERVIEW, day: () => DAY, refresh: async () => {}, ...overrides } as unknown as UsageService
}

let server: Server
let port: number
let refreshes = 0

beforeAll(async () => {
  refreshes = 0
  const routes: WebRoute[] = [
    makeUsageOverviewRoute(admittingCtx(), stubService()),
    makeUsageDayRoute(admittingCtx(), stubService()),
    makeUsageRefreshRoute(admittingCtx(), stubService({ refresh: async () => { refreshes += 1 } })),
  ]
  server = createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0]!
    const route = routes.find((entry) => entry.kind === 'exact' && entry.path === pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const url = (path: string) => `http://127.0.0.1:${port}${path}`

/** A response double that records the status and body a handler wrote. */
function probe(): { res: ServerResponse; state: { status: number; body: string } } {
  const state = { status: 0, body: '' }
  const res = {
    writeHead: (code: number) => { state.status = code },
    end: (chunk?: string) => { state.body = chunk ?? '' },
  } as unknown as ServerResponse
  return { res, state }
}

describe('usage routes', () => {
  it('serves the overview with family JSON headers and no-store', async () => {
    const res = await fetch(url(USAGE_API_PREFIX + '/overview'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(OVERVIEW)
  })

  it('user gets one retained day served for a date query', async () => {
    // Given an admitted request for a day the ledger recorded
    const res = await fetch(url(USAGE_API_PREFIX + '/day?date=2026-08-28'))
    // When the day route answers
    // Then the day's per-provider totals come back under the day envelope, uncached
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, day: DAY })
  })

  it('operator gets 400 for a date query that is not a real local day', async () => {
    // Given date queries that are a rollover, free text, and missing
    const queries = ['?date=2026-02-30', '?date=yesterday', '']
    // When the day route answers each
    const statuses = await Promise.all(queries.map(async (query) => (await fetch(url(USAGE_API_PREFIX + '/day' + query))).status))
    // Then all three are refused instead of folding into a bogus day bucket
    expect(statuses).toEqual([400, 400, 400])
  })

  it('answers 405 when the refresh endpoint is not POSTed', async () => {
    const res = await fetch(url(USAGE_API_PREFIX + '/refresh'))
    expect(res.status).toBe(405)
    expect(refreshes).toBe(0)
  })

  it('forces one probe cycle and answers with the fresh overview', async () => {
    const res = await fetch(url(USAGE_API_PREFIX + '/refresh'), { method: 'POST' })
    expect(res.status).toBe(200)
    expect(refreshes).toBe(1)
    expect(await res.json()).toEqual(OVERVIEW)
  })

  it('answers 500 when the refresh cycle fails', async () => {
    const routes = [makeUsageRefreshRoute(admittingCtx(), stubService({ refresh: async () => { throw new Error('probe boom') } }))]
    const { res, state } = probe()
    await routes[0]!.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage, res)
    expect(state.status).toBe(500)
    expect(JSON.parse(state.body)).toEqual({ ok: false, error: 'probe boom' })
  })

  it('operator gets every endpoint refused the platform does not admit', () => {
    // Given the platform refusing with 401 (no usable credential)
    const request = { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, headers: { host: '192.168.1.9:3080' } }

    // When each endpoint answers that refused request
    const overview = probe()
    void makeUsageOverviewRoute(rejectingCtx(401), stubService()).handler(request as never, overview.res)
    const refresh = probe()
    void makeUsageRefreshRoute(rejectingCtx(401), stubService()).handler({ ...request, method: 'POST' } as never, refresh.res)
    const day = probe()
    void makeUsageDayRoute(rejectingCtx(401), stubService()).handler({ ...request, url: '/api/dsh-usage/day?date=2026-08-28' } as never, day.res)

    // Then every one of them answers 401 in the plugin's own JSON shape
    expect(overview.state.status).toBe(401)
    expect(JSON.parse(overview.state.body)).toEqual({ ok: false, error: 'unauthorized' })
    expect(refresh.state.status).toBe(401)
    expect(day.state.status).toBe(401)
    expect(JSON.parse(day.state.body)).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('operator gets 403 when the platform fence refuses the request', () => {
    // Given the platform fence refusing with 403
    const { res, state } = probe()
    const request = { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, headers: { host: '192.168.1.9:3080' } }

    // When the overview answers
    void makeUsageOverviewRoute(rejectingCtx(403), stubService()).handler(request as never, res)

    // Then the refusal carries the forbidden wording
    expect(state.status).toBe(403)
    expect(JSON.parse(state.body)).toEqual({ ok: false, error: 'forbidden' })
  })

  it('operator gets the service never consulted for a refused request', async () => {
    // Given a service that would leak if the handler ran
    let consulted = 0
    const leaky = {
      overview: () => { consulted += 1; return OVERVIEW },
      day: () => { consulted += 1; return DAY },
      refresh: async () => { consulted += 1 },
    } as unknown as UsageService

    // When every endpoint answers a refused request
    const request = { method: 'GET', socket: { remoteAddress: '192.168.1.9' }, headers: { host: '192.168.1.9:3080' } }
    const overview = probe()
    void makeUsageOverviewRoute(rejectingCtx(401), leaky).handler(request as never, overview.res)
    const day = probe()
    void makeUsageDayRoute(rejectingCtx(401), leaky).handler({ ...request, url: '/api/dsh-usage/day?date=2026-08-28' } as never, day.res)
    const refresh = probe()
    void makeUsageRefreshRoute(rejectingCtx(401), leaky).handler({ ...request, method: 'POST' } as never, refresh.res)

    // Then the service was never asked for anything
    expect(consulted).toBe(0)
  })

  it('operator gets a paired-device cookie not admitted on its own', () => {
    // Given a context that exposes the pairing service the plugin used to
    // consult: a paired device is NOT a credential for the usage data anymore
    const paired = {
      connection: { requestRejection: () => 401 },
      get: (name: string, _strict?: boolean) => (name === 'remoteWebUiPairing' ? { isPairedDevice: () => true } : undefined),
    } as never
    const { res, state } = probe()
    const request = {
      method: 'GET',
      socket: { remoteAddress: '192.168.1.9' },
      headers: { host: '192.168.1.9:3080', cookie: 'dsh_pair=deadbeef' },
    }

    // When the overview answers that request
    void makeUsageOverviewRoute(paired, stubService()).handler(request as never, res)

    // Then the request is refused on the platform's decision alone
    expect(state.status).toBe(401)
  })
})
