import { session as electronSession, type Cookie } from 'electron'
import { partitionName } from '../../../shared/types'
import type { SessionStore } from '../config/store'
import { applyBrowserIdentity } from './browserIdentity'

export function getPartition(sessionId: string) {
  const ses = electronSession.fromPartition(partitionName(sessionId))
  applyBrowserIdentity(ses)
  return ses
}

export async function exportCookiesBackup(store: SessionStore, sessionId: string): Promise<void> {
  const ses = getPartition(sessionId)
  const cookies = await ses.cookies.get({})
  store.writeCookiesBackup(
    sessionId,
    cookies.map((c: Cookie) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expirationDate: c.expirationDate,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session
    }))
  )
}
