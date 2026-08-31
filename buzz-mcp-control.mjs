import { createHash } from 'node:crypto'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'buzz-mcp-control'
export const inject = ['tools']

function configDigest(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export function apply(ctx) {
  let activeFiber
  let activeDigest
  let queue = Promise.resolve()

  async function configure(config) {
    if (config === null) {
      if (activeFiber) await activeFiber.dispose()
      activeFiber = undefined
      activeDigest = undefined
      return
    }
    const digest = configDigest(config)
    if (activeFiber && digest === activeDigest) return

    if (activeFiber) {
      await activeFiber.dispose()
      activeFiber = undefined
      activeDigest = undefined
    }

    const fiber = ctx.plugin(mcpClient, config)
    try {
      await fiber.await()
      activeFiber = fiber
      activeDigest = digest
    } catch {
      await fiber.dispose().catch(() => {})
      throw new Error('The trusted Buzz reply MCP server did not initialize')
    }
  }

  function onMessage(message) {
    if (message?.kind !== 'buzz-mcp-control/configure') return
    queue = queue
      .then(() => configure(message.config))
      .then(
        () => process.send?.({ kind: 'buzz-mcp-control/result', id: message.id, ok: true }),
        () => process.send?.({
          kind: 'buzz-mcp-control/result',
          id: message.id,
          ok: false,
          error: 'The trusted Buzz reply MCP server did not initialize',
        }),
      )
  }

  process.on('message', onMessage)
  return async () => {
    process.off('message', onMessage)
    await queue.catch(() => {})
    await activeFiber?.dispose()
  }
}
