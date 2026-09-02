import { useEffect, useState } from 'react'
import type { DistillMergePlan } from '@shared/types'
import { useModal } from './useModal'

/**
 * The merge confirmation — the one place a distill run is allowed to change the
 * vault, so it says exactly what it will do before it does it.
 *
 * The interesting case is a NAME CLASH. A run's "Options" and your "Options" are
 * not necessarily the same idea, so the run's copy is saved beside yours as
 * "Options (Book)" and you get one tick-box per clash: *same as the existing
 * note*. Unticked (the default) means two notes, two dots on the map. Ticked
 * writes `same_as:: [[Options]]` into the merged copy — a line you can read and
 * delete — and the map then draws them as one.
 */
export function MergeDialog({
  plan,
  folder,
  onCancel,
  onConfirm
}: {
  plan: DistillMergePlan
  /** Vault-relative folder the notes will land in. */
  folder: string
  onCancel: () => void
  /** Names of the staged notes the user confirmed are the same as their twin. */
  onConfirm: (sameAs: string[]) => void
}): React.JSX.Element {
  const modalRef = useModal()
  const [sameAs, setSameAs] = useState<Set<string>>(new Set())

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const fresh = plan.entries.filter((e) => e.action === 'new')
  const clashes = plan.entries.filter((e) => e.action === 'collides')
  const identical = plan.entries.filter((e) => e.action === 'identical')
  const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

  const toggle = (name: string): void =>
    setSameAs((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="modal merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-summary"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-message" id="merge-summary">
          Merge into <code>{folder}</code>:
          <ul className="merge-summary">
            <li>
              {fresh.length} new {plural(fresh.length, 'note')}
            </li>
            {clashes.length > 0 && (
              <li>
                {clashes.length} {plural(clashes.length, 'note')}{' '}
                {plural(clashes.length, 'shares', 'share')} a name with a note you already have —{' '}
                {plural(clashes.length, 'it', 'they')}&apos;ll be saved under{' '}
                {plural(clashes.length, 'a new name', 'new names')}, as shown below
              </li>
            )}
            {identical.length > 0 && (
              <li>
                {identical.length} identical, skipped — you already have{' '}
                {plural(identical.length, 'it', 'them')}
              </li>
            )}
          </ul>
        </div>
        {clashes.length > 0 && (
          <div className="merge-clashes">
            {clashes.map((e) => (
              <label key={e.name} className="merge-clash">
                <input
                  type="checkbox"
                  checked={sameAs.has(e.name)}
                  onChange={() => toggle(e.name)}
                />
                <span className="merge-clash-name">
                  {e.name} → {e.targetName}
                </span>
                <span className="merge-clash-hint">same as the existing “{e.name}”</span>
              </label>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-danger merge-confirm"
            onClick={() => onConfirm([...sameAs])}
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  )
}
