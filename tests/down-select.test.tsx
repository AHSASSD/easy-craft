// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DownSelect } from '../src/components/DownSelect';
afterEach(cleanup);
test('downward picker filters a long list, supports paging and restores focus on escape', () => {
  const onChange = vi.fn();
  const parentKey = vi.fn();
  render(
    createElement(
      'div',
      { onKeyDown: parentKey },
      createElement(DownSelect, {
        label: '版本',
        value: 'v0',
        options: Array.from({ length: 100 }, (_, index) => ({
          value: `v${index}`,
          label: `v${index}`,
        })),
        onChange,
      }),
    ),
  );
  const trigger = screen.getByRole('combobox', { name: '版本' });
  fireEvent.click(trigger);
  const search = screen.getByRole('searchbox', { name: '筛选版本' });
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: 'v9' } });
  expect(screen.getAllByRole('option')).toHaveLength(11);
  fireEvent.keyDown(search, { key: 'PageDown' });
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('v95');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  parentKey.mockClear();
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
  expect(parentKey).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
