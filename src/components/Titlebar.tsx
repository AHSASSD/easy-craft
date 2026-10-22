import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Box, Minus, Square, X } from 'lucide-react';
export function Titlebar({ report }: { report(message: string): void }) {
  const native = isTauri();
  const control = (
    action: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging',
  ) => {
    if (native) {
      const window = getCurrentWindow();
      void window[action]().catch(() =>
        report('窗口操作失败，请使用系统窗口管理。'),
      );
    }
  };
  return (
    <header className="titlebar">
      <div
        className="brand"
        onPointerDown={(event) => {
          if (event.button === 0) control('startDragging');
        }}
      >
        <Box size={21} />
        <strong>Easy Craft</strong>
        <span>V0.1</span>
      </div>
      <div
        className="title-drag"
        onPointerDown={(event) => {
          if (event.button === 0) control('startDragging');
        }}
      />
      <span className="demo-pill">演示模式</span>
      {native ? (
        <div className="window-controls">
          <button aria-label="最小化" onClick={() => control('minimize')}>
            <Minus size={15} />
          </button>
          <button
            aria-label="最大化或还原"
            onClick={() => control('toggleMaximize')}
          >
            <Square size={13} />
          </button>
          <button aria-label="关闭窗口" onClick={() => control('close')}>
            <X size={17} />
          </button>
        </div>
      ) : (
        <span className="browser-label">浏览器预览</span>
      )}
    </header>
  );
}
