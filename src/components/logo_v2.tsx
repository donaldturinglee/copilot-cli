import React from 'react'
import { TEARDROP_ASTERISK } from '../constants/figures.js'
import { Box } from '../ink/components/box.js'
import { buildLogoHeaderInfo } from '../utilities/logo_v2_utils.js'
import { Byline } from './design_system/byline.js'
import { ThemedBox } from './design_system/themed_box.js'
import { ThemedText } from './design_system/themed_text.js'

export type LogoV2Props = {
  version?: string
  model?: string | null
  cwd: string
  permissionMode?: string
  compact?: boolean
  showTips?: boolean
}

export function LogoV2({
  version,
  model,
  cwd,
  permissionMode,
  compact = false,
  showTips = true,
}: LogoV2Props): React.ReactNode {
  const info = buildLogoHeaderInfo({
    version,
    model,
    cwd,
    permissionMode,
    isNewUser: showTips,
  })

  if (compact) {
    return (
      <Box flexDirection="row" gap={1}>
        <ThemedText color="claude" bold>
          {TEARDROP_ASTERISK} Copilot CLI
        </ThemedText>
        <ThemedText dimColor>v{info.version}</ThemedText>
        <ThemedText dimColor>· {info.modelLabel}</ThemedText>
      </Box>
    )
  }

  return (
    <ThemedBox
      flexDirection="column"
      borderStyle="round"
      borderColor="claude"
      paddingX={1}
    >
      <Box flexDirection="row" gap={1}>
        <ThemedText color="claude" bold>
          {TEARDROP_ASTERISK} Welcome to Copilot CLI
        </ThemedText>
        <ThemedText dimColor>v{info.version}</ThemedText>
      </Box>
      <Byline>
        <ThemedText dimColor>Model: {info.modelLabel}</ThemedText>
        <ThemedText dimColor>Mode: {info.modeLabel}</ThemedText>
        <ThemedText dimColor>{info.cwdDisplay}</ThemedText>
      </Byline>
      {showTips && info.tips.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {info.tips.slice(0, 2).map((tip, idx) => (
            <ThemedText key={idx} dimColor>
              · {tip}
            </ThemedText>
          ))}
        </Box>
      ) : null}
    </ThemedBox>
  )
}
