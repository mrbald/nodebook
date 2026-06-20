import { useEffect, useRef, useState } from 'react'

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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
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
