import { expect, test } from 'bun:test'
import type { MessagePage } from '@/lib/opencode/client'
import { SessionMessageLoader } from './session-message-loader'
import { ChildStoreManager } from './child-store'

const emptyPage: MessagePage = { items: [], cursor: {} }

test('loads messages after a Strict Mode cleanup and effect setup', async () => {
  const childStores = new ChildStoreManager()
  let messageRequests = 0
  let resolveFirstRequest: ((value: MessagePage) => void) | undefined
  const sdk = { getSessionMessages: async () => {
    messageRequests += 1
    if (messageRequests === 1) return new Promise<MessagePage>((resolve) => { resolveFirstRequest = resolve })
    return emptyPage
  } }
  const loader = new SessionMessageLoader(childStores as never, { sdk, runtimeKey: 'runtime' })
  const firstLoad = loader.ensure({ directory: '/project', sessionID: 'session-1' })
  loader.dispose(); loader.activate(); await loader.ensure({ directory: '/project', sessionID: 'session-1' })
  resolveFirstRequest?.(emptyPage); await firstLoad
  expect(messageRequests).toBe(2)
  expect(loader.getSnapshot({ directory: '/project', sessionID: 'session-1' }).status).toBe('ready')
})
