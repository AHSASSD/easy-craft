import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
export function AddInstanceMenu({
  disabled,
  onPack,
  onLocal,
}: {
  disabled: boolean;
  onPack(): void;
  onLocal(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div
      className="instance-add-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') setOpen(false);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ) ?? [],
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          items[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) %
                  items.length
          ]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        aria-label="添加游戏实例"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={17} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="添加游戏实例选项"
          className="instance-add-options"
        >
          <button
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              close();
              onPack();
            }}
          >
            导入本地整合包
          </button>
          <button
            role="menuitem"
            disabled={disabled}
            onClick={() => {
              close();
              onLocal();
            }}
          >
            扫描/导入本地版本
          </button>
        </div>
      )}
    </div>
  );
}
