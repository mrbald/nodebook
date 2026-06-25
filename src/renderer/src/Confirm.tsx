import { useEffect } from 'react'
import { useModal } from './useModal'

interface ConfirmProps {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/** A yes/no modal (delete confirmation). Reuses the `.modal-*` styles. */
export function Confirm({ message, confirmLabel, onConfirm, onCancel }: ConfirmProps) {
  const modalRef = useModal()
  // Escape closes; Enter/Space activate whichever button has focus (the dialog
  // opens with Cancel focused, so an accidental Enter won't fire the destructive
  // action). Button activation is native — no global Enter handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-message" id="confirm-message">
          {message}
        </div>
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
