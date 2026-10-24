// @vitest-environment jsdom
/** Preparation has one owner, retains failed choices and fences earlier accounts. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeHomeInputModel } from '../src/client/home-input-model.ts'

function fixture(prepare = vi.fn<ConstructorParameters<typeof OfficeHomeInputModel>[0]>().mockResolvedValue(true)) {
  const model = new OfficeHomeInputModel(prepare)
  model.bind('employee' as OfficeMemberId)
  onTestFinished(() => { model.dispose() })
  return { model, prepare }
}

it('publishes metadata without reading private bytes and removes only the chosen file', () => {
  const { model, prepare } = fixture()
  model.add([new File(['private source content'], 'one.txt'), new File(['two'], 'two.txt')])
  const files = model.state.getSnapshot().files
  expect(files.map(file => [file.name, file.byteLength])).toEqual([['one.txt', 22], ['two.txt', 3]])
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain('private source content')
  expect(prepare).not.toHaveBeenCalled()
  model.remove(files[0]!.id)
  expect(model.state.getSnapshot().files.map(file => file.name)).toEqual(['two.txt'])
})

it('rejects empty sends and admits just one of two simultaneous sends', async () => {
  const pending = Promise.withResolvers<boolean>()
  const { model, prepare } = fixture(vi.fn().mockReturnValue(pending.promise))
  expect(await model.start(' ', true)).toBe(false)
  const file = new File(['actual selection'], 'report.txt')
  model.add([file])
  const sending = model.start('read this', true)
  expect(await model.start('read this', true)).toBe(false)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0]![1]).toEqual([file])
  expect(model.state.getSnapshot().preparing).toBe(true)
  pending.resolve(true)
  expect(await sending).toBe(true)
  expect(model.state.getSnapshot()).toEqual({ files: [], preparing: false, failed: false })
})

it('keeps the same browser handles for a safe retry after preparation fails', async () => {
  const { model, prepare } = fixture()
  prepare.mockResolvedValueOnce(false)
  const file = new File(['kept content'], 'kept.txt')
  model.add([file])
  const original = model.state.getSnapshot().files
  expect(await model.start('draft', true)).toBe(false)
  expect(model.state.getSnapshot()).toEqual({ files: original, preparing: false, failed: true })
  expect(await model.start('draft', true)).toBe(true)
  expect(prepare.mock.calls[0]![1][0]).toBe(file)
  expect(prepare.mock.calls[1]![1][0]).toBe(file)
})

it('does not let cancelled preparation clear a newer selection or its busy state', async () => {
  const old = Promise.withResolvers<boolean>()
  const next = Promise.withResolvers<boolean>()
  const { model, prepare } = fixture(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise))
  model.add([new File(['old'], 'old.txt')])
  const earlier = model.start('old draft', true)
  const signal = prepare.mock.calls[0]![3]
  model.cancel()
  expect(signal.aborted).toBe(true)
  model.remove(model.state.getSnapshot().files[0]!.id)
  model.add([new File(['new'], 'new.txt')])
  const later = model.start('new draft', true)
  old.resolve(true)
  expect(await earlier).toBe(false)
  expect(model.state.getSnapshot().files.map(file => file.name)).toEqual(['new.txt'])
  expect(model.state.getSnapshot().preparing).toBe(true)
  next.resolve(true)
  expect(await later).toBe(true)
})

it('clears private choices on account replacement and ignores the previous account success', async () => {
  const pending = Promise.withResolvers<boolean>()
  const { model, prepare } = fixture(vi.fn().mockReturnValue(pending.promise))
  model.add([new File(['first account'], 'private.txt')])
  const saving = model.start('private prompt', true)
  model.bind('another_employee' as OfficeMemberId)
  expect(prepare.mock.calls[0]![3].aborted).toBe(true)
  pending.resolve(true)
  expect(await saving).toBe(false)
  expect(model.state.getSnapshot()).toEqual({ files: [], preparing: false, failed: false })
  model.bind(null)
  model.add([new File(['denied'], 'unauthenticated.txt')])
  expect(await model.start('denied', true)).toBe(false)
  expect(model.state.getSnapshot().files).toEqual([])
})

it('disposes retained handles and ignores a late prepared result after unload', async () => {
  const pending = Promise.withResolvers<boolean>()
  const { model, prepare } = fixture(vi.fn().mockReturnValue(pending.promise))
  model.add([new File(['content'], 'unloaded.txt')])
  const saving = model.start('prompt', false)
  model.dispose()
  expect(prepare.mock.calls[0]![3].aborted).toBe(true)
  pending.resolve(true)
  expect(await saving).toBe(false)
  expect(model.state.getSnapshot()).toEqual({ files: [], preparing: false, failed: false })
})
