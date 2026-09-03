import { useEffect, useRef, useState } from 'react'
import { useModal } from './useModal'

/** A one-click filling of the field — a named lens, in the caller's words. */
export interface PromptPreset {
  label: string
  value: string
}

interface PromptProps {
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  /** Buttons above the field; clicking one replaces what is typed. */
  presets?: PromptPreset[]
  maxLength?: number
  /** Whether confirming with an empty field means something. Off by default:
   *  a new note has to be named, but an optional answer is confirmable empty. */
  allowEmpty?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function Prompt({
  title,
  initialValue,
  placeholder,
  confirmLabel,
  presets,
  maxLength,
  allowEmpty,
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
    if (trimmed || allowEmpty) {
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
        {presets && presets.length > 0 && (
          <div className="modal-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className="modal-preset"
                onClick={() => {
                  setValue(p.value)
                  inputRef.current?.focus()
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          placeholder={placeholder}
          maxLength={maxLength}
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
