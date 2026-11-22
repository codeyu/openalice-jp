import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { userDataHome } from '../core/paths.js'
import {
  readQuickChatPreferences, readAutoQuantPreferences,
  rememberRecentChatWorkspace, rememberAutoQuantDefaultWorkspace,
} from '../core/preferences.js'
import type { WorkspaceService } from './service.js'

const setupSchema = z.object({
  schemaVersion: z.literal(1),
  pending: z.array(z.enum(['chat', 'auto-quant', 'auto-prediction'])),
  errors: z.record(z.string(), z.string()).optional(),
})
/**
 * This fork does not ship Auto Prediction (prediction markets): it is never
 * created by default, and a pending request left by an older build is dropped.
 * The schema still accepts the value so existing setup files keep parsing.
 */
const DEFAULT_WORKSPACES = ['chat', 'auto-quant'] as const
type DefaultWorkspace = typeof DEFAULT_WORKSPACES[number]
const isDefaultWorkspace = (kind: string): kind is DefaultWorkspace => (DEFAULT_WORKSPACES as readonly string[]).includes(kind)

/** Consumes an explicit project-birth request under the backend's writer lease.
 * Success is checkpointed only after the canonical default preference is saved.
 * Resolvers reuse an existing instance if a previous attempt was interrupted.
 */
async function prepareUnlocked(
  service: Pick<WorkspaceService, 'registry' | 'resolveOrCreateChatWorkspace' | 'resolveOrCreateAutoQuantWorkspace'>,
  options: { home?: string; onProgress?: (workspace: string, error?: string) => void } = {},
): Promise<void> {
  const home = options.home ?? userDataHome
  const path = join(home, 'workspace-setup.json')
  let request: z.infer<typeof setupSchema>
  try { request = setupSchema.parse(JSON.parse(await readFile(path, 'utf8'))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    request = { schemaVersion: 1, pending: [] }
  }
  request.pending = request.pending.filter(isDefaultWorkspace)
  if (request.errors) delete request.errors['auto-prediction']
  const preferences = join(home, 'data', 'preferences.json')
  const selected: Record<DefaultWorkspace, string | null | undefined> = {
    chat: (await readQuickChatPreferences(preferences)).recentChatWorkspaceId,
    'auto-quant': (await readAutoQuantPreferences(preferences)).defaultWorkspaceId,
  }
  const templates: Record<DefaultWorkspace, string> = {
    chat: 'chat', 'auto-quant': 'auto-quant-v2',
  }
  for (const kind of DEFAULT_WORKSPACES) {
    const id = selected[kind]
    if (id && service.registry.get(id)?.template === templates[kind]) continue
    if (!request.pending.includes(kind)) request.pending.push(kind)
  }
  await mkdir(home, { recursive: true })
  await writeFile(path, JSON.stringify(request, null, 2) + '\n', { mode: 0o600 })
  for (const kind of [...new Set(request.pending)]) {
    options.onProgress?.(kind)
    try {
      const result = kind === 'chat'
        ? await service.resolveOrCreateChatWorkspace((await readQuickChatPreferences(preferences)).recentChatWorkspaceId)
        : await service.resolveOrCreateAutoQuantWorkspace((await readAutoQuantPreferences(preferences)).defaultWorkspaceId)
      if (!result.ok) throw new Error(result.message)
      if (kind === 'chat') await rememberRecentChatWorkspace(result.workspace.id, preferences)
      else await rememberAutoQuantDefaultWorkspace(result.workspace.id, preferences)
      request.pending = request.pending.filter(item => item !== kind)
      if (request.errors) delete request.errors[kind]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      request.errors = { ...request.errors, [kind]: message }
      options.onProgress?.(kind, message)
    }
    const temp = `${path}.tmp`
    await writeFile(temp, JSON.stringify(request, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, path)
  }
}

const gates = new WeakMap<object, Promise<void>>()
const phases = new WeakMap<object, 'preparing' | 'complete'>()
export function prepareProjectWorkspaces(...args: Parameters<typeof prepareUnlocked>): Promise<void> {
  const [service] = args
  phases.set(service, 'preparing')
  const run = (gates.get(service) ?? Promise.resolve()).catch(() => {}).then(() => prepareUnlocked(...args))
    .finally(() => { if (gates.get(service) === run) phases.set(service, 'complete') })
  gates.set(service, run)
  return run
}

export async function readProjectWorkspaceSetup(home = userDataHome, service?: object) {
  try {
    return { ...setupSchema.parse(JSON.parse(await readFile(join(home, 'workspace-setup.json'), 'utf8'))), phase: service ? phases.get(service) ?? 'idle' : 'complete' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, pending: [], errors: {}, phase: service ? phases.get(service) ?? 'idle' : 'complete' }
    throw error
  }
}
