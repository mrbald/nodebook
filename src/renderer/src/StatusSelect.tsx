import { useEffect, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  /** Distinguishes instances for styling + tests, e.g. "mode" / "theme". */
  kind: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
}

/**
 * A small, non-intrusive status-bar dropdown (JetBrains-style): shows the
 * current value and opens an upward popup to pick another. Used for both the
 * view-mode and app-theme selectors in the bottom-right status bar.
 */
export function StatusSelect({ kind, value, options, onChange, title }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className={`status-select status-select-${kind}`} ref={wrapRef}>
      {open && (
        <div className="status-menu" role="menu">
          {options.map((o) => (
            <div
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`status-menu-item${o.value === value ? ' active' : ''}`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
      <button className="status-btn" title={title} onClick={() => setOpen((o) => !o)}>
        {current?.label ?? value} ▾
      </button>
    </div>
  )
}
