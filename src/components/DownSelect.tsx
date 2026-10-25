import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export function DownSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  allowCustom = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
  allowCustom?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement>(() => document.body);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 240,
  });
  const filtered = options
    .filter((option) =>
      option.label.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => Number(b.value === query) - Number(a.value === query));
  const choices =
    allowCustom &&
    query.trim() &&
    !options.some((option) => option.value === query.trim())
      ? [
          { value: query.trim(), label: `使用版本 ${query.trim()}` },
          ...filtered,
        ]
      : filtered;
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function show() {
    setContainer(
      trigger.current?.closest<HTMLElement>('.app') ?? document.body,
    );
    setQuery('');
    setActive(0);
    setOpen(true);
  }
  function select(next: string) {
    onChange(next);
    close();
  }
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    trigger.current.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    const rect = trigger.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(0, Math.min(280, innerHeight - rect.bottom - 18)),
    });
    popup.current?.querySelector('input')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const reposition = (event: Event) => {
      if (popup.current?.contains(event.target as Node)) return;
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || rect.bottom < 0 || rect.top >= innerHeight) {
        setOpen(false);
        return;
      }
      setPosition({
        top: rect.bottom + 6,
        left: rect.left,
        width: rect.width,
        maxHeight: Math.max(0, Math.min(280, innerHeight - rect.bottom - 18)),
      });
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [open]);
  return (
    <>
      <button
        className="down-select"
        type="button"
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            show();
          }
        }}
      >
        <span>
          {options.find((option) => option.value === value)?.label ??
            (value || '请选择')}
        </span>
        <ChevronDown size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="down-select-popup"
            style={position}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (event.key === 'Tab') setOpen(false);
              const delta =
                event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowUp'
                    ? -1
                    : event.key === 'PageDown'
                      ? 6
                      : event.key === 'PageUp'
                        ? -6
                        : 0;
              if (delta) {
                event.preventDefault();
                const next = Math.max(
                  0,
                  Math.min(choices.length - 1, active + delta),
                );
                setActive(next);
                popup.current
                  ?.querySelector(`[data-option-index="${next}"]`)
                  ?.scrollIntoView?.({ block: 'nearest' });
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                if (choices[active]) select(choices[active].value);
              }
            }}
          >
            <input
              role="searchbox"
              aria-controls={id}
              aria-activedescendant={
                choices[active] ? `${id}-${active}` : undefined
              }
              maxLength={allowCustom ? 100 : 256}
              aria-label={`筛选${label}`}
              placeholder="输入关键词筛选…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
            />
            <div role="listbox" aria-label={`${label}选项`} id={id}>
              {choices.map((option, index) => (
                <button
                  id={`${id}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  tabIndex={-1}
                  className={index === active ? 'highlighted' : ''}
                  data-option-index={index}
                  key={option.value}
                  onMouseMove={() => setActive(index)}
                  onClick={() => select(option.value)}
                >
                  {option.label}
                </button>
              ))}
              {!choices.length && <p>没有匹配项</p>}
            </div>
          </div>,
          container,
        )}
    </>
  );
}
