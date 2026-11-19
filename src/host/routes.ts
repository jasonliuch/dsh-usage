import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { writeJson } from './http.ts'
import { isLedgerDateKey } from '../core/ledger.ts'
import type { UsageDayResponse } from '../core/types.ts'
import type { UsageService } from './usage-service.ts'

export const USAGE_API_PREFIX = '/api/dsh-usage'

/**
 * The platform's admission decision for one request: undefined when the
 * request may proceed, 401 when it carries no usable credential, 403 when the
 * Host/Origin fence refuses it.
 *
 * The usage routes are ordinary host routes, so the platform's own admission
 * policy is the ONLY trust fence in front of them. That policy is the same one
 * every other `/api` route in the GUI obeys: the Host/Origin fence (DNS
 * rebinding defense) plus a live signed browser session cookie. The plugin
 * deliberately owns no fence of its own — a hand-rolled one would be a second,
 * weaker policy that could only ever narrow the platform's, and the plugin
 * used to carry a paired-device cookie path (a third-party, retired gate) that
 * admitted anyone holding it from any network path.
 *
 * @param ctx - host context; exposes the `connection` service.
 * @param request - the incoming HTTP request.
 * @returns undefined to proceed, or the status to answer with.
 */
function usageRejection(ctx: Context, request: IncomingMessage): 401 | 403 | undefined {
  return ctx.connection.requestRejection(request)
}

/**
 * Answer a rejected request in the plugin's own JSON shape. The status is the
 * platform's decision: 401 for a missing or invalid credential, 403 for a
 * request the Host/Origin fence refuses.
 * @param res - the response to write.
 * @param rejection - the status to answer with.
 */
function writeRejection(res: ServerResponse, rejection: 401 | 403): void {
  writeJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
}

/**
 * Overview route: provider balances, plan quotas, and token usage totals.
 * Personal account data, served under the platform's admission policy — the
 * same one the rest of the GUI's `/api` surface obeys.
 * @param ctx - host context; exposes the `connection` service.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageOverviewRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/overview',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      const rejection = usageRejection(ctx, req)
      if (rejection !== undefined) {
        writeRejection(res, rejection)
        return
      }
      writeJson(res, 200, service.overview(), { 'cache-control': 'no-store' })
    },
  }
}

/**
 * One retained day route: `GET /api/dsh-usage/day?date=YYYY-MM-DD` answers
 * that local day's per-provider and per-model totals, so the section's day
 * pickers can show a past day instead of only today. Same admission policy as
 * the overview route, and a key that is not a real local date is refused with
 * 400 rather than folded into a bogus day.
 * @param ctx - host context; exposes the `connection` service.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageDayRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/day',
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      const rejection = usageRejection(ctx, req)
      if (rejection !== undefined) {
        writeRejection(res, rejection)
        return
      }
      const date = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('date') ?? ''
      if (!isLedgerDateKey(date)) {
        writeJson(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' })
        return
      }
      writeJson(res, 200, { ok: true, day: service.day(date) } satisfies UsageDayResponse, { 'cache-control': 'no-store' })
    },
  }
}

/**
 * Manual refresh: forces one probe cycle now and answers with the fresh
 * overview. Same admission policy as the overview route.
 * @param ctx - host context; exposes the `connection` service.
 * @param service - the usage service.
 * @returns the route.
 */
export function makeUsageRefreshRoute(ctx: Context, service: UsageService): WebRoute {
  return {
    kind: 'exact',
    path: USAGE_API_PREFIX + '/refresh',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const rejection = usageRejection(ctx, req)
      if (rejection !== undefined) {
        writeRejection(res, rejection)
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        await service.refresh()
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'refresh failed' })
        return
      }
      writeJson(res, 200, service.overview(), { 'cache-control': 'no-store' })
    },
  }
}
