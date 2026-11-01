// @vitest-environment jsdom
import { useState } from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { afterEach, test, expect, vi } from 'vitest';
import { useAutoEditor } from '../src/features/useAutoEditor';
import {
  UnsavedChanges,
  useNavigationGuard,
} from '../src/features/UnsavedChanges';
afterEach(cleanup);
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  },
  close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  },
});
function Editor({
  write,
  leave,
}: {
  write(value: string): Promise<void>;
  leave(): void;
}) {
  const [value, setValue] = useState('start');
  const [base, setBase] = useState('start');
  const guard = useNavigationGuard();
  const auto = useAutoEditor({
    key: value,
    dirty: value !== base,
    blocked: false,
    automatic: true,
    save: async () => {
      await write(value);
      setBase(value);
    },
    discard: () => setValue(base),
  });
  return (
    <>
      <input
        aria-label="value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button onClick={() => guard(leave)}>leave</button>
      {auto.error && <p role="alert">{auto.error}</p>}
    </>
  );
}
test('rapid edits coalesce and navigation flushes without an unsaved confirmation', async () => {
  const write = vi.fn(async () => {});
  const leave = vi.fn();
  render(
    <UnsavedChanges>
      <Editor write={write} leave={leave} />
    </UnsavedChanges>,
  );
  fireEvent.change(screen.getByLabelText('value'), {
    target: { value: 'one' },
  });
  fireEvent.change(screen.getByLabelText('value'), {
    target: { value: 'two' },
  });
  await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith('two'), {
    timeout: 2000,
  });
  fireEvent.change(screen.getByLabelText('value'), {
    target: { value: 'three' },
  });
  fireEvent.click(screen.getByText('leave'));
  await waitFor(() => expect(leave).toHaveBeenCalledOnce());
  expect(write).toHaveBeenLastCalledWith('three');
  expect(screen.queryByRole('dialog')).toBeNull();
});
test('failed automatic saving retains the edits and prevents silent navigation', async () => {
  const write = vi.fn(async () => {
    throw Error('disk unavailable');
  });
  const leave = vi.fn();
  render(
    <UnsavedChanges>
      <Editor write={write} leave={leave} />
    </UnsavedChanges>,
  );
  fireEvent.change(screen.getByLabelText('value'), {
    target: { value: 'keep' },
  });
  fireEvent.click(screen.getByText('leave'));
  await screen.findByRole('dialog');
  expect(leave).not.toHaveBeenCalled();
  expect((screen.getByLabelText('value') as HTMLInputElement).value).toBe(
    'keep',
  );
  expect(screen.getAllByText('disk unavailable').length).toBeGreaterThan(0);
});
