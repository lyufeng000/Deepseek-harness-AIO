import { jsx } from 'react/jsx-runtime';
import css from './MessageText.module.css';
import './SettingsScroll.css';

export { ImageGallery } from 'aio-upstream-gallery';
export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface';

export function MessageText({ text }: { text: string }) {
  return jsx('div', { className: css.text, children: text });
}

export const inject = [];

let users = 0;
let style: HTMLStyleElement | undefined;

export function apply(ctx: { effect: (effect: () => () => void) => unknown }) {
  ctx.effect(() => {
    if (users++ === 0) {
      style = document.createElement('style');
      style.dataset.plugin = 'dsh-aio-ui-compat';
      style.textContent = '__AIO_CSS_PAYLOAD__';
      document.head.appendChild(style);
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (--users === 0) {
        style?.remove();
        style = undefined;
      }
    };
  });
}
