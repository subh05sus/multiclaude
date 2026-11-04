import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { moveTarget, profileOf } from './target'
import type { BoardState } from './target'

const POLL_MS = 15_000

const targetAtom = atom({ plugin: 'multiclaude-move', key: 'target' } as const, null)
const movedAtom = atom({ plugin: 'multiclaude-move', key: 'moved' } as const, null)

type Host = {
  env: { get: (name: 'MC_HOME' | 'HOME' | 'MC_PROFILE' | 'CLAUDE_CONFIG_DIR') => Promise<string | undefined> }
}

async function mcDirOf($: Host): Promise<string> {
  return (await $.env.get('MC_HOME')) ?? `${await $.env.get('HOME')}/.multiclaude`
}

// One click reopens the conversation on the other account. Nothing here moves a session by itself.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    const refresh = async () => {
      const dir = await mcDirOf($)
      const profile = profileOf(await $.env.get('MC_PROFILE'), await $.env.get('CLAUDE_CONFIG_DIR'), dir)
      const state = JSON.parse(await $.fs.read(`${dir}/state.json`)) as BoardState
      const to = moveTarget(state, profile)
      if (to !== (await read($, targetAtom))) await update($, targetAtom, () => to)
    }
    await refresh().catch(() => undefined)
    $.clock.every(POLL_MS, () => refresh().catch(() => undefined))

    return result
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const to = await read($, targetAtom)
    const moved = await read($, movedAtom)
    const below = await next(e)
    if (!to && !moved) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const press = async () => {
      if (!to) return
      try {
        const dir = await mcDirOf($)
        const { port } = JSON.parse(await $.fs.read(`${dir}/config.json`)) as { port: number }
        const secret = (await $.fs.read(`${dir}/secret`)).trim()
        const r = await $.http.fetch(`http://127.0.0.1:${port}/api/move`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-mc-token': secret },
          body: JSON.stringify({ sessionId: await $.session.id(), to }),
        })
        if (r.ok) await update($, movedAtom, () => to)
        else $.ui.toast((JSON.parse(r.text) as { error?: string }).error ?? `Could not move (${r.status}).`)
      } catch {
        $.ui.toast('Could not reach multiclaude. Run "mc doctor", or use "mc next".')
      }
    }

    return (
      <Box flexDirection="column">
        {moved ? (
          <Text dimColor>Moved to {moved} in a new window. Close this one.</Text>
        ) : (
          <Box>
            <Button key="move" label={`Move to ${to}`} onPress={press} />
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
