// Extend only the pinned native configuration ceiling; retain its scheduler.
// The existing numeric panel control has no maximum and already accepts 30.
export const PROACTIVE_LIMIT_PATCHES = [
  {
    package: 'dsh-aurabot-qq', version: '1.1.24', rootIndex: 0, file: 'src/core/config.js',
    before: '1f6125e7be6f718d3c705d27479487b435b0dcdb36ec2eb74f40b30d784e8deb',
    after: '0309e40efa56a99a4a381f8055be08af564ce0895b3d845f192f3dce11b23873',
    needle: '  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 20)',
    replacement: '  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 30)',
  },
]
