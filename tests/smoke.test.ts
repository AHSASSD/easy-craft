import { expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { App } from '../src/app/App';

test('app explicitly identifies demo mode', () => {
  expect(renderToStaticMarkup(createElement(App))).toContain('演示模式');
});
