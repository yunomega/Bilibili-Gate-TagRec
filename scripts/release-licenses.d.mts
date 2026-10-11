import type { Plugin } from 'vite'

export interface ReleaseLicenseManifest {
  schemaVersion: number
  pending: string[]
  noticesSha256: string
  scriptSha256: string
}

export function embedNotices(script: string, notices: string): string
export function validateDistribution(
  script: string,
  notices: string,
  manifest: ReleaseLicenseManifest,
  expectedLicense: string,
): void
export function releaseLicenses(): Plugin[]
