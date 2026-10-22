// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/app/App';

test('app explicitly identifies demo mode', () => {
  render(createElement(App));
  expect(screen.getByText('演示模式')).toBeTruthy();
  expect(screen.getByRole('button', { name: /模拟启动/ })).toBeTruthy();
  cleanup();
});
