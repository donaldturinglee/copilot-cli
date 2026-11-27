/**
 * PowerShell alias expansion table and dangerous cmdlet classification sets.
 * Canonical names are stored lowercase for case-insensitive PowerShell matching.
 */

export const COMMON_PS_ALIASES: Readonly<Record<string, string>> = {
  // Code execution / dynamic invocation
  iex: 'invoke-expression',
  icm: 'invoke-command',
  saps: 'start-process',
  start: 'start-process',
  ii: 'invoke-item',
  // Network / downloaders
  iwr: 'invoke-webrequest',
  curl: 'invoke-webrequest',
  wget: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  // File & directory mutation
  rm: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  rd: 'remove-item',
  rmdir: 'remove-item',
  ri: 'remove-item',
  sc: 'set-content',
  ac: 'add-content',
  clc: 'clear-content',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  ni: 'new-item',
  ren: 'rename-item',
  rni: 'rename-item',
  mkdir: 'new-item',
  md: 'new-item',
  // Environment / variables / aliases
  sv: 'set-variable',
  set: 'set-variable',
  rv: 'remove-variable',
  gv: 'get-variable',
  sal: 'set-alias',
  nal: 'new-alias',
  // Read-only navigation & inspection
  ls: 'get-childitem',
  dir: 'get-childitem',
  gci: 'get-childitem',
  cat: 'get-content',
  gc: 'get-content',
  type: 'get-content',
  pwd: 'get-location',
  gl: 'get-location',
  cd: 'set-location',
  sl: 'set-location',
  chdir: 'set-location',
  pushd: 'push-location',
  popd: 'pop-location',
  sls: 'select-string',
  gi: 'get-item',
  gp: 'get-itemproperty',
  rvpa: 'resolve-path',
  echo: 'write-output',
  write: 'write-output',
  measure: 'measure-object',
  sort: 'sort-object',
  select: 'select-object',
  where: 'where-object',
  '?': 'where-object',
  foreach: 'foreach-object',
  '%': 'foreach-object',
  ft: 'format-table',
  fl: 'format-list',
  fw: 'format-wide',
  tee: 'tee-object',
  ps: 'get-process',
  gps: 'get-process',
  kill: 'stop-process',
  spps: 'stop-process',
  gcm: 'get-command',
  man: 'get-help',
  help: 'get-help',
  ipmo: 'import-module',
  gmo: 'get-module',
}

export const DANGEROUS_SCRIPT_BLOCK_CMDLETS = new Set([
  'invoke-expression',
  'invoke-command',
  'start-job',
  'start-threadjob',
  'register-objectevent',
  'register-engineevent',
  'register-scheduledtask',
  'register-scheduledjob',
  'new-scriptblock',
  'foreach-object',
  'where-object',
  'add-type',
  'new-object',
  'set-alias',
  'new-alias',
])

export const FILEPATH_EXECUTION_CMDLETS = new Set([
  'start-process',
  'invoke-item',
  'invoke-command',
  'start-job',
  'import-powershellDataFile'.toLowerCase(),
])

export const MODULE_LOADING_CMDLETS = new Set([
  'import-module',
  'install-module',
  'install-script',
  'add-type',
  'update-typeData'.toLowerCase(),
  'update-formatData'.toLowerCase(),
])

export const DOWNLOADER_CMDLETS = new Set([
  'invoke-webrequest',
  'invoke-restmethod',
  'start-bitstransfer',
  'new-object',
])

/**
 * Strips PowerShell module qualification prefix (e.g.
 * `Microsoft.PowerShell.Utility\Invoke-Expression` -> `Invoke-Expression`).
 */
export function stripModulePrefix(commandName: string): string {
  const backslashIdx = commandName.lastIndexOf('\\')
  if (backslashIdx !== -1 && !commandName.includes(':') && !commandName.startsWith('.')) {
    return commandName.slice(backslashIdx + 1)
  }
  return commandName
}

/**
 * Resolves a PowerShell command name or alias (stripping module prefix) to its
 * canonical lowercase cmdlet/command name.
 */
export function resolvePsAlias(commandName: string): string {
  const stripped = stripModulePrefix(commandName).trim().toLowerCase()
  return COMMON_PS_ALIASES[stripped] ?? stripped
}
