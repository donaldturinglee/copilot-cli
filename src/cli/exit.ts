export function cliError(message?: string): never {
  if (message) {
    console.error(message)
  }
  process.exit(1)
  return undefined as never
}

export function cliOk(message?: string): never {
  if (message) {
    process.stdout.write(message + '\n')
  }
  process.exit(0)
  return undefined as never
}
