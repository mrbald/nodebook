import { useEffect } from 'react'

interface ConfirmProps {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/** A yes/no modal (delete confirmation). Reuses the `.modal-*` styles. */
export function Confirm({ message, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-message">{message}</div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-danger" onClick={onConfirm}>
            {confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}
