/**
 * Natural-language Bash prompt-rule classifier facade.
 * Supports optional prompt-based Bash allow/ask/deny descriptions and
 * injectable test transports.
 */

import type {
  ClassifierBehavior,
  ClassifierResult,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { isFeatureEnabled } from '../feature_flags.js'
import { sideQuery } from '../side_query.js'
import { getDefaultHaikuModel } from '../model/model.js'
import { extractClassifierXmlTag } from './classifier_shared.js'

export type { ClassifierBehavior, ClassifierResult }

export type BashClassifierTransport = (params: {
  command: string
  cwd: string
  behavior: ClassifierBehavior
  descriptions: string[]
  signal?: AbortSignal
}) => Promise<ClassifierResult>

let testBashClassifierTransport: BashClassifierTransport | null = null

export function setBashClassifierTransportForTesting(
  transport: BashClassifierTransport | null,
): void {
  testBashClassifierTransport = transport
}

export function isClassifierPermissionsEnabled(): boolean {
  return isFeatureEnabled('BASH_CLASSIFIER')
}

function extractPromptDescriptions(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  behavior: ClassifierBehavior,
): string[] {
  const sourceMap =
    behavior === 'deny'
      ? permissionContext.alwaysDenyRules
      : behavior === 'ask'
        ? permissionContext.alwaysAskRules
        : permissionContext.alwaysAllowRules

  const descriptions: string[] = []
  for (const entries of Object.values(sourceMap)) {
    if (!entries) continue
    for (const rule of entries) {
      const match = rule.match(/^Bash\(prompt:([\s\S]+)\)$/)
      if (match?.[1]?.trim()) {
        descriptions.push(match[1].trim())
      }
    }
  }
  return descriptions
}

export function getBashPromptAllowDescriptions(
  permissionContext: DeepImmutable<ToolPermissionContext>,
): string[] {
  return extractPromptDescriptions(permissionContext, 'allow')
}

export function getBashPromptAskDescriptions(
  permissionContext: DeepImmutable<ToolPermissionContext>,
): string[] {
  return extractPromptDescriptions(permissionContext, 'ask')
}

export function getBashPromptDenyDescriptions(
  permissionContext: DeepImmutable<ToolPermissionContext>,
): string[] {
  return extractPromptDescriptions(permissionContext, 'deny')
}

export async function classifyBashCommand(params: {
  command: string
  cwd: string
  behavior: ClassifierBehavior
  descriptions: string[]
  signal?: AbortSignal
}): Promise<ClassifierResult> {
  if (params.descriptions.length === 0) {
    return {
      matches: false,
      confidence: 'high',
      reason: 'No prompt descriptions configured.',
    }
  }

  if (testBashClassifierTransport) {
    return testBashClassifierTransport(params)
  }

  try {
    const bulletList = params.descriptions
      .map((d, i) => `${i + 1}. ${d}`)
      .join('\n')
    const response = await sideQuery({
      model: getDefaultHaikuModel(),
      system:
        'Determine whether the shell command matches any of the listed natural-language rule descriptions. Reply with XML: <matches>yes|no</matches><matched>exact description or empty</matched><confidence>high|medium|low</confidence><reason>concise explanation</reason>',
      messages: [
        {
          role: 'user',
          content: `CWD: ${params.cwd}\nCommand: ${params.command}\nBehavior: ${params.behavior}\nDescriptions:\n${bulletList}`,
        },
      ],
      maxTokens: 256,
      signal: params.signal,
      querySource: 'bash_classifier',
    })

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')

    const matchesRaw = extractClassifierXmlTag(text, 'matches')?.toLowerCase()
    const matched = extractClassifierXmlTag(text, 'matched')
    const confRaw = extractClassifierXmlTag(text, 'confidence')?.toLowerCase()
    const reason =
      extractClassifierXmlTag(text, 'reason') ?? 'Evaluated by bash classifier.'
    const confidence =
      confRaw === 'high' || confRaw === 'medium' || confRaw === 'low'
        ? confRaw
        : 'low'

    return {
      matches: matchesRaw === 'yes' || matchesRaw === 'true',
      ...(matched ? { matchedDescription: matched } : {}),
      confidence,
      reason,
    }
  } catch (error) {
    return {
      matches: false,
      confidence: 'low',
      reason: `Classifier unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
