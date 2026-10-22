// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/app/App';
import { bootstrap, kernel } from '../src/app/bootstrap';

test('app explicitly identifies demo mode', async () => {
  render(createElement(App, { services: await bootstrap() }));
  expect(screen.getByText('演示模式')).toBeTruthy();
  expect(screen.getByRole('button', { name: /模拟启动/ })).toBeTruthy();
  cleanup();
  await kernel.stop();
});
