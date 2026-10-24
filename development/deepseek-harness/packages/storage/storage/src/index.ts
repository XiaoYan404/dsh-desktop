/**
 * Storage hub (`ctx.storage`): a named backend registry plus mounted
 * data-form facilities. The hub itself performs no IO — backends own media,
 * data forms (the domain layer first) own semantics.
 * @module @deepseek-ai/dsh-storage
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { StorageError } from './error.ts'
import { BackendRegistry } from './registry.ts'

export { BackendRegistry } from './registry.ts'
export { StorageError } from './error.ts'
export type { StorageErrorCode } from './error.ts'
export { UNIT_NAME_RE } from './backend.ts'
export { StorageMutationValidationError } from './atomic.ts'
export type { KvAtomicMutation, KvAtomicRecordMutation } from './atomic.ts'
export type { StorageBackend, KvFacet, KvUnit, KvUnitDescriptor } from './backend.ts'

/**
 * Derive the Cordis lifecycle service that one named backend plugin provides.
 * Domain-form providers inject these keys so activation cannot race backend
 * registration even though callers continue resolving backends through the
 * storage registry.
 * @param name - Backend registry name.
 * @returns the corresponding lifecycle-only service key.
 */
export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storage: Storage
  }
}

/**
 * Data forms mountable on the hub, keyed by form name. Form owners extend
 * this map via declaration merging (the domain layer merges
 * `domain: DomainFacility`) and mount the facility in their `apply`.
 */
export interface StorageForms {}

/**
 * The storage hub service. Backends register under `backend`; data forms
 * mount under their `StorageForms` key and are reached as `ctx.storage.<form>`.
 */
export class Storage extends Service {
  /** Named backend table; multiple backends stay mounted side by side. */
  readonly backend: BackendRegistry = new BackendRegistry()

  private readonly forms = new Map<keyof StorageForms, unknown>()
  private readonly backendDrains = new Map<string, Set<() => Promise<void>>>()

  constructor(ctx: Context) {
    super(ctx, 'storage')
  }

  /**
   * Retain a data-form drain before its backend releases units during plugin teardown.
   * @param name - Backend registry name used by the data form.
   * @param drain - Fence consumer admission and finish accepted operations.
   * @returns Removal callback, called after the form has finished closing.
   */
  beforeBackendClose(name: string, drain: () => Promise<void>): () => void {
    const callbacks = this.backendDrains.get(name) ?? new Set<() => Promise<void>>()
    this.backendDrains.set(name, callbacks)
    callbacks.add(drain)
    return () => {
      callbacks.delete(drain)
      if (callbacks.size === 0 && this.backendDrains.get(name) === callbacks) this.backendDrains.delete(name)
    }
  }

  /**
   * Drain dependent forms before unregistering and closing a backend; failed drains still release it.
   * @param name - Backend registry name being retired.
   * @param close - Provider-owned unregister and medium cleanup operation.
   * @returns Completion after every drain and the medium cleanup; failures are collected together.
   */
  async closeBackend(name: string, close: () => Promise<void>): Promise<void> {
    const drained = await Promise.allSettled([...(this.backendDrains.get(name) ?? [])].map(async drain => drain()))
    const closed = await Promise.allSettled([Promise.resolve().then(close)])
    const errors = [...drained, ...closed].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, `Storage backend '${name}' failed to close`)
  }

  /**
   * Mount a data-form facility on the hub. Mounting is an effect: the
   * returned disposer unmounts the form.
   * @param form - Form key declared in {@link StorageForms}.
   * @param facility - The facility instance to expose.
   * @returns the disposer that unmounts the form.
   */
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void {
    if (this.forms.has(form)) {
      throw new StorageError('duplicate-mount', `storage form '${String(form)}' is already mounted`)
    }
    this.forms.set(form, facility)
    return () => {
      // Same stale-disposer guard as BackendRegistry.register.
      if (this.forms.get(form) === facility) {
        this.forms.delete(form)
      }
    }
  }

  /**
   * Resolve a mounted data form.
   * @param form - Form key declared in {@link StorageForms}.
   * @returns the mounted facility.
   */
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form)) {
      throw new StorageError('form-not-mounted', `storage form '${String(form)}' is not mounted`)
    }
    return this.forms.get(form) as StorageForms[K]
  }

  /** Domain data form; present once the domain layer plugin is loaded. */
  get domain(): StorageForms extends { domain: infer D } ? D : never {
    return this.form('domain' as keyof StorageForms)
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped (packages/AGENTS.md): mixing a default export with a
// function-plugin `apply` makes the Loader drop the plugin namespace.
export default Storage
