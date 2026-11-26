/**
 * Semver comparison utilities that use Bun.semver when available
 * and fall back to the npm `semver` package in Node.js environments.
 */

let cachedNpmSemver: typeof import('semver') | undefined

function getNpmSemver(): typeof import('semver') {
  if (!cachedNpmSemver) {
    cachedNpmSemver = require('semver') as typeof import('semver')
  }
  return cachedNpmSemver
}

export function gt(left: string, right: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(left, right) === 1
  }
  return getNpmSemver().gt(left, right, { loose: true })
}

export function gte(left: string, right: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(left, right) >= 0
  }
  return getNpmSemver().gte(left, right, { loose: true })
}

export function lt(left: string, right: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(left, right) === -1
  }
  return getNpmSemver().lt(left, right, { loose: true })
}

export function lte(left: string, right: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(left, right) <= 0
  }
  return getNpmSemver().lte(left, right, { loose: true })
}

export function satisfies(version: string, range: string): boolean {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.satisfies(version, range)
  }
  return getNpmSemver().satisfies(version, range, { loose: true })
}

export function order(left: string, right: string): -1 | 0 | 1 {
  if (typeof Bun !== 'undefined') {
    return Bun.semver.order(left, right)
  }
  return getNpmSemver().compare(left, right, { loose: true })
}
