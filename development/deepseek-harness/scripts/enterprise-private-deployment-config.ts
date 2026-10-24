/** Secret-free deployment artifacts and opt-in, unauthenticated reachability checks. */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const credential = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const address = z.string().min(1).max(2000).refine((value) => {
  if (!URL.canParse(value) || /[\\\u0000-\u0020\u007f]/.test(value)) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Use an HTTP(S) URL without credentials, query parameters or a fragment')
const origin = address.refine(value => new URL(value).origin === value)
const member = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), name: z.string().trim().min(1).max(200),
  department: z.string().max(200), jobTitle: z.string().max(200), role: z.enum(['admin', 'manager', 'employee']),
}).strict()
const telemetry = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disabled') }).strict(),
  z.object({ mode: z.literal('feedback-only'), endpoint: address }).strict(),
])
const search = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), baseURL: address, model: z.string().trim().min(1).max(200), apiKeyEnv: credential }).strict(),
])
const schema = z.object({
  version: z.literal(1), home: z.string().min(1).max(2000).refine(value => !/[\u0000-\u001f]/.test(value)),
  office: z.object({
    companyName: z.string().trim().min(1).max(200), timeZone: z.string().refine((value) => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true }
      catch (error) { if (error instanceof RangeError) return false; throw error }
    }),
    members: z.array(member).min(1).max(1000), principalId: z.string().min(1),
    scheduleAvailabilityEnabled: z.boolean(),
    connectorAllowedOrigins: z.array(origin).max(100), connectorCredentials: z.record(identifier, credential),
    connectorTimeoutMs: z.number().int().min(100).max(120000),
  }).strict().superRefine((office, ctx) => {
    if (new Set(office.members.map(value => value.id)).size !== office.members.length ||
      !office.members.some(value => value.id === office.principalId) || !office.members.some(value => value.role === 'admin')) {
      ctx.addIssue({ code: 'custom', message: 'Use unique members, an existing principal and an administrator' })
    }
    if (new Set(office.connectorAllowedOrigins).size !== office.connectorAllowedOrigins.length) {
      ctx.addIssue({ code: 'custom', message: 'Use unique canonical connector origins' })
    }
  }),
  model: z.object({
    route: identifier, displayName: z.string().trim().min(1).max(200),
    baseURL: address, api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
    apiKeyEnv: credential.optional(),
    models: z.array(z.object({ id: z.string().trim().min(1).max(200),
      contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
    }).strict()).min(1).max(100),
  }).strict().superRefine((model, ctx) => {
    if (new Set(model.models.map(value => value.id)).size !== model.models.length) {
      ctx.addIssue({ code: 'custom', message: 'Use unique model ids' })
    }
    if (model.models.some(value => value.maxTokens > value.contextWindow)) {
      ctx.addIssue({ code: 'custom', message: 'Model output capacity cannot exceed context capacity' })
    }
  }),
  privacy: z.object({ sessionTelemetry: telemetry, productAnalytics: z.enum(['disabled', 'profile-default']),
    webSearch: search, webFetch: z.boolean(),
  }).strict(),
  diagnostics: z.object({ timeoutMs: z.number().int().min(100).max(30000),
    probes: z.array(z.object({ name: identifier, url: address }).strict()).max(20),
  }).strict(),
}).strict()

/** Validated public values; credentials are reference names only. */
export type PrivateDeployment = z.infer<typeof schema>

/** Expected deployment failures never include parsed input, remote bodies or exception messages. */
export class DeploymentError extends Error {
  constructor(readonly code: 'invalid_config' | 'invalid_probe' | 'output_exists' | 'artifact_mismatch' | 'io_error', message: string) {
    super(message)
  }
}

/** Parse untrusted JSON and resolve its data home relative to the config file.
 * @param text - Public JSON without inline credentials.
 * @param filename - Absolute config location used for relative paths.
 * @returns Validated configuration with an absolute home.
 * @throws DeploymentError for invalid input; raw values are never included.
 */
export function parsePrivateDeployment(text: string, filename: string): PrivateDeployment {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new DeploymentError('invalid_config', 'Invalid deployment JSON. Use the documented version 1 example; keep secret values in the credential provider.')
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new DeploymentError('invalid_config', 'Invalid deployment fields. Check paths, company members, URLs, credential reference names and explicit privacy choices against the example.')
  }
  const config = result.data
  config.home = resolve(dirname(filename), config.home)
  const approved = new Set([new URL(config.model.baseURL).origin, ...config.office.connectorAllowedOrigins,
    ...(config.privacy.webSearch.enabled ? [new URL(config.privacy.webSearch.baseURL).origin] : []),
    ...(config.privacy.sessionTelemetry.mode === 'feedback-only' ? [new URL(config.privacy.sessionTelemetry.endpoint).origin] : []),
  ])
  if (config.diagnostics.probes.some(probe => !approved.has(new URL(probe.url).origin)) ||
    new Set(config.diagnostics.probes.map(probe => probe.name)).size !== config.diagnostics.probes.length) {
    throw new DeploymentError('invalid_probe', 'Probe names must be unique and every probe origin must match a configured model, connector, search or telemetry origin.')
  }
  return config
}

/** Compile overrides for the existing Web profile without modifying a user profile.
 * @param config - Validated deployment choices.
 * @returns Patch rows consumed by the existing dsh --patch option.
 */
export function privateDeploymentPatches(config: PrivateDeployment): PatchOptions[] {
  const { principalId, ...office } = config.office
  const { route, ...model } = config.model
  const privacy = config.privacy
  const patches: PatchOptions[] = [
    { id: 'enterprise-office', disabled: false, config: { ...office, dshHome: config.home } },
    { id: 'ui-office', disabled: false, config: { principalId } },
    { id: 'tool-office', disabled: false, config: { approval: 'manual' } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
    { id: 'llm-pi-ai', config: { providers: { [route]: model } } },
    { id: 'session-telemetry-otel', disabled: privacy.sessionTelemetry.mode === 'disabled',
      ...(privacy.sessionTelemetry.mode === 'feedback-only' ? { config: { mode: 'FEEDBACK_ONLY',
        exporter: { url: privacy.sessionTelemetry.endpoint, compression: 'gzip', timeoutMillis: 1000 },
        processor: { scheduledDelayMillis: 10000, maxQueueSize: 2048, maxExportBatchSize: 2048, exportTimeoutMillis: 1500 },
        maxRequestBytes: 4000000, shutdownTimeoutMillis: 3000,
      } } : {}) },
    { id: 'web-search-deepseek', disabled: !privacy.webSearch.enabled,
      ...(privacy.webSearch.enabled ? { config: { baseURL: privacy.webSearch.baseURL, model: privacy.webSearch.model,
        apiKeyEnv: privacy.webSearch.apiKeyEnv } } : {}) },
    { id: 'web-fetch-http', disabled: !privacy.webFetch },
    { id: 'tool-web', disabled: !privacy.webFetch && !privacy.webSearch.enabled },
  ]
  if (privacy.productAnalytics === 'disabled') {
    patches.push({ id: 'desktop-product-telemetry', disabled: true }, { id: 'product-analytics', disabled: true })
  }
  return patches
}

/** Resolve artifact bytes deterministically; JSON is accepted by the YAML patch loader.
 * @param config - Validated deployment choices.
 * @param directory - Absolute artifact directory used in launch arguments.
 * @returns Public patch and launch metadata; no shell code or credential values.
 */
export function privateDeploymentArtifacts(config: PrivateDeployment, directory: string): Record<string, string> {
  const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
  return {
    'private-office.patch.yml': json(privateDeploymentPatches(config)),
    'launch.json': json({ environment: { DSH_HOME: config.home }, command: 'pnpm',
      args: ['dsh', 'web', '--patch', join(resolve(directory), 'private-office.patch.yml'), '--no-open'],
      workingDirectory: resolve(import.meta.dirname, '..'),
    }),
  }
}

/** Write a new artifact directory exclusively; existing files and data homes are never overwritten.
 * @param config - Validated deployment choices.
 * @param directory - New destination whose parent already exists.
 * @returns After both public artifacts are written; a write failure leaves an incomplete directory for inspection.
 * @throws DeploymentError if the destination exists or a file operation fails.
 */
export async function writePrivateDeployment(config: PrivateDeployment, directory: string): Promise<void> {
  try { await mkdir(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DeploymentError('output_exists', 'Artifact destination already exists. Verify it or choose a new directory; existing data is retained.')
    }
    throw new DeploymentError('io_error', 'Could not create the artifact directory. Check its parent directory and write permissions.')
  }
  for (const [name, content] of Object.entries(privateDeploymentArtifacts(config, directory))) {
    try { await writeFile(join(directory, name), content, { flag: 'wx', mode: 0o600 }) }
    catch (_error) {
      // Directory ownership remains with the caller; a partial result must stay visibly incomplete.
      throw new DeploymentError('io_error', 'Artifact writing failed. Keep the incomplete directory for inspection and retry in a new directory.')
    }
  }
}

/** Compare artifacts with the current declared choices without reading application data or credentials.
 * @param config - Validated deployment choices.
 * @param directory - Previously written artifact directory.
 * @returns After every artifact matches exactly.
 * @throws DeploymentError for missing, unreadable or changed artifacts.
 */
export async function verifyPrivateDeployment(config: PrivateDeployment, directory: string): Promise<void> {
  for (const [name, expected] of Object.entries(privateDeploymentArtifacts(config, directory))) {
    let actual: string
    try { actual = await readFile(join(directory, name), 'utf8') }
    catch (_error) { throw new DeploymentError('artifact_mismatch', 'Deployment artifacts are missing or unreadable. Generate a new directory and review it before launch.') }
    if (actual !== expected) throw new DeploymentError('artifact_mismatch', 'Deployment artifacts differ from the declared choices. Review the changes or generate a new directory before launch.')
  }
}

/** Read directory existence and intended paths without enumerating or reading private application files.
 * @param config - Validated deployment choices.
 * @returns Configured local locations; these are not observations of a running Host's overrides.
 */
export async function privateDeploymentReport(config: PrivateDeployment): Promise<Record<string, unknown>> {
  let homeStatus: 'directory' | 'missing' | 'not-directory' | 'unreadable'
  try { homeStatus = (await stat(config.home)).isDirectory() ? 'directory' : 'not-directory' }
  catch (error) { homeStatus = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  return {
    scope: 'Declared configuration; does not attest a running Host or enforce a process firewall',
    homeStatus,
    locations: { home: config.home, profile: join(config.home, 'profiles', 'web'), sessions: join(config.home, 'sessions'),
      storages: join(config.home, 'storages'), attachments: join(config.home, 'attachments', 'v1'),
      officeDrive: join(config.home, 'office', 'drive', 'v1'), officeChat: join(config.home, 'office', 'chat', 'v1'),
      credentials: join(config.home, '.credentials.yaml'), cache: join(config.home, 'cache'),
    },
    model: config.model,
    connectorPolicy: { allowedOrigins: config.office.connectorAllowedOrigins, credentialAliases: config.office.connectorCredentials },
    privacy: config.privacy,
    remainingNetworkCapabilities: ['Other installed model and account routes', 'Shell, subprocess, browser, MCP and installed plugins',
      'Enabled company connectors; approved origins constrain office connector requests only',
      ...(config.privacy.webFetch ? ['Web fetch can request arbitrary permitted HTTP(S) destinations'] : []),
      ...(config.privacy.productAnalytics === 'profile-default' ? ['Product analytics follows the selected profile and later patches'] : []),
    ],
    probes: config.diagnostics.probes,
    recovery: 'Keep the same configuration, restore service/network access, and explicitly repeat --probe; no probe mutates settings or sends credentials.',
  }
}

/** One unauthenticated GET outcome. A successful check does not verify model inference or business authorization. */
export interface DeploymentProbeResult {
  name: string
  status: 'reachable' | 'authentication-required' | 'http-error' | 'redirect-blocked' | 'unreachable' | 'timeout' | 'cancelled'
  httpStatus?: number
}

/** Check reviewed endpoints once each; no redirects, credentials, response bodies, implicit retries or cookies.
 * @param config - Validated probe allowlist and complete per-request deadline.
 * @param signal - Caller cancellation; remaining endpoints are reported cancelled.
 * @returns Sanitized results in declared order; offline failures leave all artifacts and application state untouched.
 */
export async function probePrivateDeployment(config: PrivateDeployment, signal?: AbortSignal): Promise<DeploymentProbeResult[]> {
  const results: DeploymentProbeResult[] = []
  for (const probe of config.diagnostics.probes) {
    if (signal?.aborted) { results.push({ name: probe.name, status: 'cancelled' }); continue }
    const deadline = AbortSignal.timeout(config.diagnostics.timeoutMs)
    const lifetime = signal === undefined ? deadline : AbortSignal.any([deadline, signal])
    try {
      const response = await fetch(probe.url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: lifetime })
      const status = response.status >= 300 && response.status < 400 ? 'redirect-blocked'
        : response.status === 401 || response.status === 403 ? 'authentication-required'
          : response.ok ? 'reachable' : 'http-error'
      await response.body?.cancel()
      results.push({ name: probe.name, status, httpStatus: response.status })
    } catch (_error) {
      // Fetch exceptions can include addresses or remote details; report only the operation's typed outcome.
      results.push({ name: probe.name, status: signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'unreachable' })
    }
  }
  return results
}
