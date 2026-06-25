import { useEffect, useRef, useState } from 'react'
import { useModal } from './useModal'

interface PromptProps {
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function Prompt({
  title,
  initialValue,
  placeholder,
  confirmLabel,
  onConfirm,
  onCancel,
}: PromptProps) {
  const [value, setValue] = useState(initialValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const modalRef = useModal()

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [])

  function handleConfirm() {
    const trimmed = value.trim()
    if (trimmed) {
      onConfirm(trimmed)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleConfirm()
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title" id="prompt-title">
          {title}
        </div>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="modal-actions">
          <button className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-primary" onClick={handleConfirm}>
            {confirmLabel ?? 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
