export type BoardState = {
  pick?: { name?: string | null }
  profiles?: { name: string; peak?: number; switchAt?: number }[]
}

/** Which account this session runs on, the way `mc` works it out. */
export function profileOf(mcProfile: string | undefined, configDir: string | undefined, mcDir: string): string {
  if (mcProfile) return mcProfile
  const prefix = `${mcDir}/profiles/`
  if (configDir?.startsWith(prefix)) return configDir.slice(prefix.length).split('/')[0] || 'main'
  return 'main'
}

/** The account to offer, once this one is past its switch-at level and another has room. */
export function moveTarget(state: BoardState | null, profile: string): string | null {
  const me = state?.profiles?.find(p => p.name === profile)
  const to = state?.pick?.name
  if (!me || !to || to === profile) return null
  return (me.peak ?? 0) >= (me.switchAt ?? 90) ? to : null
}
