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
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Open with the current choice focused so arrows/Enter work immediately.
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('.status-menu-item')
    const active = menuRef.current?.querySelector<HTMLButtonElement>('.status-menu-item.active')
    ;(active ?? items?.[0])?.focus()

    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Up/Down move focus between options (wrapping); Enter/Space pick natively.
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.status-menu-item') ?? []
    )
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
    items[next].focus()
  }

  const choose = (v: string): void => {
    onChange(v)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const current = options.find((o) => o.value === value)

  return (
    <div className={`status-select status-select-${kind}`} ref={wrapRef}>
      {open && (
        <div className="status-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`status-menu-item${o.value === value ? ' active' : ''}`}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <button
        ref={triggerRef}
        className="status-btn"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value} ▾
      </button>
    </div>
  )
}
