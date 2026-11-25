import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type {
  AgentColorName,
  HookCallbackMatcher,
  HookEvent,
  ModelSetting,
  ModelStrings,
  ModelUsage,
  OtelAttributes,
  OtelEventLogger,
  OtelLoggerProvider,
  OtelMeter,
  OtelMeterProvider,
  OtelMetricOptions,
  OtelTracerProvider,
  PluginHookMatcher,
  SettingSource,
} from '../types/forward.js'
import type { SessionId } from '../types/ids.js'
import { isFeatureEnabled } from '../utils/feature_flags.js'
import { createSignal } from '../utils/signal.js'

type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: OtelAttributes): void
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  agentId?: string
}

export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export type SlowOperationEntry = {
  operation: string
  durationMs: number
  timestamp: number
}

type State = {
  originalCwd: string
  projectRoot: string
  totalCostUsd: number
  totalApiDuration: number
  totalApiDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  meter: OtelMeter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  parentSessionId: SessionId | undefined
  loggerProvider: OtelLoggerProvider | null
  eventLogger: OtelEventLogger | null
  meterProvider: OtelMeterProvider | null
  tracerProvider: OtelTracerProvider | null
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  lastApiRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  lastApiRequestMessages: BetaMessageStreamParams['messages'] | null
  lastClassifierRequests: unknown[] | null
  cachedClaudeMdContent: string | null
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  inlinePlugins: Array<string>
  chromeFlagOverride: boolean | undefined
  useCoworkPlugins: boolean
  sessionBypassPermissionsMode: boolean
  scheduledTasksEnabled: boolean
  sessionCronTasks: SessionCronTask[]
  sessionCreatedTeams: Set<string>
  sessionTrustAccepted: boolean
  sessionPersistenceDisabled: boolean
  hasExitedPlanMode: boolean
  needsPlanModeExitAttachment: boolean
  needsAutoModeExitAttachment: boolean
  lspRecommendationShownThisSession: boolean
  initJsonSchema: Record<string, unknown> | null
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  planSlugCache: Map<string, string>
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  invokedSkills: Map<string, InvokedSkillInfo>
  slowOperations: SlowOperationEntry[]
  sdkBetas: string[] | undefined
  mainThreadAgentType: string | undefined
  isRemoteMode: boolean
  directConnectServerUrl: string | undefined
  systemPromptSectionCache: Map<string, string | null>
  lastEmittedDate: string | null
  additionalDirectoriesForClaudeMd: string[]
  allowedChannels: ChannelEntry[]
  hasDevChannels: boolean
  sessionProjectDir: string | null
  promptCache1hAllowlist: string[] | null
  promptCache1hEligible: boolean | null
  afkModeHeaderLatched: boolean | null
  fastModeHeaderLatched: boolean | null
  cacheEditingHeaderLatched: boolean | null
  thinkingClearLatched: boolean | null
  promptId: string | null
  lastMainRequestId: string | undefined
  lastApiCompletionTimestamp: number | null
  pendingPostCompaction: boolean
}

const MAX_IN_MEMORY_ERRORS = 100
const SCROLL_DRAIN_IDLE_MS = 150
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000
const EMPTY_SLOW_OPERATIONS: ReadonlyArray<SlowOperationEntry> = []

let settingsCacheResetter: (() => void) | undefined

/**
 * Registers the settings cache reset callback (wired by settings_cache.ts)
 * so bootstrap/state.ts remains a pure leaf of the import DAG.
 */
export function registerSettingsCacheResetter(resetter: () => void): void {
  settingsCacheResetter = resetter
}

function getInitialState(): State {
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  return {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUsd: 0,
    totalApiDuration: 0,
    totalApiDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    loggerProvider: null,
    eventLogger: null,
    meterProvider: null,
    tracerProvider: null,
    agentColorMap: new Map(),
    agentColorIndex: 0,
    lastApiRequest: null,
    lastApiRequestMessages: null,
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    inMemoryErrorLog: [],
    inlinePlugins: [],
    chromeFlagOverride: undefined,
    useCoworkPlugins: false,
    sessionBypassPermissionsMode: false,
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    sessionTrustAccepted: false,
    sessionPersistenceDisabled: false,
    hasExitedPlanMode: false,
    needsPlanModeExitAttachment: false,
    needsAutoModeExitAttachment: false,
    lspRecommendationShownThisSession: false,
    initJsonSchema: null,
    registeredHooks: null,
    planSlugCache: new Map(),
    teleportedSessionInfo: null,
    invokedSkills: new Map(),
    slowOperations: [],
    sdkBetas: undefined,
    mainThreadAgentType: undefined,
    isRemoteMode: false,
    directConnectServerUrl: undefined,
    systemPromptSectionCache: new Map(),
    lastEmittedDate: null,
    additionalDirectoriesForClaudeMd: [],
    allowedChannels: [],
    hasDevChannels: false,
    sessionProjectDir: null,
    promptCache1hAllowlist: null,
    promptCache1hEligible: null,
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }
}

const STATE: State = getInitialState()

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

const sessionSwitched = createSignal<[id: SessionId]>()

export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}

export const onSessionSwitch = sessionSwitched.subscribe

export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setOriginalCwd(directory: string): void {
  STATE.originalCwd = directory.normalize('NFC')
}

export function setProjectRoot(directory: string): void {
  STATE.projectRoot = directory.normalize('NFC')
}

export function getCwdState(): string {
  return STATE.cwd
}

export function setCwdState(directory: string): void {
  STATE.cwd = directory.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalApiDuration += duration
  STATE.totalApiDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCostForTests(): void {
  STATE.totalApiDuration = 0
  STATE.totalApiDurationWithoutRetries = 0
  STATE.totalCostUsd = 0
}

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUsd += cost
}

export function getTotalCostUsd(): number {
  return STATE.totalCostUsd
}

export function getTotalApiDuration(): number {
  return STATE.totalApiDuration
}

export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

export function getTotalApiDurationWithoutRetries(): number {
  return STATE.totalApiDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

let interactionTimeDirty = false

function flushInteractionTimeInner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTimeInner()
  } else {
    interactionTimeDirty = true
  }
}

export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTimeInner()
  }
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
let budgetContinuationCount = 0

export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}

export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}

export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}

export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}

export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined

export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

export function getIsScrollDraining(): boolean {
  return scrollDraining
}

export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, SCROLL_DRAIN_IDLE_MS)
      timer.unref?.()
    })
  }
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

export function resetCostState(): void {
  STATE.totalCostUsd = 0
  STATE.totalApiDuration = 0
  STATE.totalApiDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

export function setCostStateForRestore({
  totalCostUsd,
  totalApiDuration,
  totalApiDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUsd: number
  totalApiDuration: number
  totalApiDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUsd = totalCostUsd
  STATE.totalApiDuration = totalApiDuration
  STATE.totalApiDurationWithoutRetries = totalApiDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  interactionTimeDirty = false
  sessionSwitched.clear()
}

export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

export function resetModelStringsForTesting(): void {
  STATE.modelStrings = null
}

export function setMeter(
  meter: OtelMeter,
  createCounter: (name: string, options: OtelMetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  STATE.sessionCounter = createCounter('copilot_cli.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('copilot_cli.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('copilot_cli.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('copilot_cli.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('copilot_cli.cost.usage', {
    description: 'Cost of the CLI session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('copilot_cli.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'copilot_cli.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('copilot_cli.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): OtelMeter | null {
  return STATE.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

export function getLoggerProvider(): OtelLoggerProvider | null {
  return STATE.loggerProvider
}

export function setLoggerProvider(provider: OtelLoggerProvider | null): void {
  STATE.loggerProvider = provider
}

export function getEventLogger(): OtelEventLogger | null {
  return STATE.eventLogger
}

export function setEventLogger(logger: OtelEventLogger | null): void {
  STATE.eventLogger = logger
}

export function getMeterProvider(): OtelMeterProvider | null {
  return STATE.meterProvider
}

export function setMeterProvider(provider: OtelMeterProvider | null): void {
  STATE.meterProvider = provider
}

export function getTracerProvider(): OtelTracerProvider | null {
  return STATE.tracerProvider
}

export function setTracerProvider(provider: OtelTracerProvider | null): void {
  STATE.tracerProvider = provider
}

export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

export function getClientType(): string {
  return STATE.clientType
}

export function setClientType(clientType: string): void {
  STATE.clientType = clientType
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

export function getKairosActive(): boolean {
  return STATE.kairosActive
}

export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

export function setFlagSettingsPath(filePath: string | undefined): void {
  STATE.flagSettingsPath = filePath
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

export function setApiKeyFromFd(apiKey: string | null): void {
  STATE.apiKeyFromFd = apiKey
}

export function setLastApiRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  STATE.lastApiRequest = params
}

export function getLastApiRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return STATE.lastApiRequest
}

export function setLastApiRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  STATE.lastApiRequestMessages = messages
}

export function getLastApiRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return STATE.lastApiRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift()
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

export function getInMemoryBootstrapErrorLog(): Array<{
  error: string
  timestamp: string
}> {
  return [...STATE.inMemoryErrorLog]
}

export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  settingsCacheResetter?.()
}

export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(task => !idSet.has(task.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    if (matchers) {
      STATE.registeredHooks[eventKey]!.push(...matchers)
    }
  }
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    if (!matchers) continue
    const callbackHooks = matchers.filter(matcher => !('pluginRoot' in matcher))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function addSlowOperation(operation: string, durationMs: number): void {
  if (!isFeatureEnabled('SLOW_OPERATION_LOGGING')) return
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const now = Date.now()
  STATE.slowOperations = STATE.slowOperations.filter(
    entry => now - entry.timestamp < SLOW_OPERATION_TTL_MS,
  )
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

export function getSlowOperations(): ReadonlyArray<SlowOperationEntry> {
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  if (
    STATE.slowOperations.some(
      entry => now - entry.timestamp >= SLOW_OPERATION_TTL_MS,
    )
  ) {
    STATE.slowOperations = STATE.slowOperations.filter(
      entry => now - entry.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  return STATE.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(value: boolean): void {
  STATE.afkModeHeaderLatched = value
}

export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

export function setFastModeHeaderLatched(value: boolean): void {
  STATE.fastModeHeaderLatched = value
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(value: boolean): void {
  STATE.cacheEditingHeaderLatched = value
}

export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

export function setThinkingClearLatched(value: boolean): void {
  STATE.thinkingClearLatched = value
}

export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}

export function getPromptId(): string | null {
  return STATE.promptId
}

export function setPromptId(promptId: string | null): void {
  STATE.promptId = promptId
}
