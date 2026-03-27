import React from 'react';
import { createRoot } from 'react-dom/client';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';

let root = null;
let mountedTarget = null;

function unmountEmojiMart() {
  if (root) {
    root.unmount();
    root = null;
  }
  mountedTarget = null;
}

function mountEmojiMart(targetId, onSelect) {
  const target = document.getElementById(targetId);
  if (!target) return false;

  if (mountedTarget !== target) {
    unmountEmojiMart();
  }
  if (!root) {
    root = createRoot(target);
    mountedTarget = target;
  }

  root.render(
    React.createElement(Picker, {
      data,
      theme: 'light',
      previewPosition: 'none',
      navPosition: 'top',
      perLine: 8,
      maxFrequentRows: 2,
      onEmojiSelect: (emoji) => {
        if (typeof onSelect === 'function') onSelect(emoji);
      }
    })
  );
  return true;
}

window.EmojiMartBridge = {
  mountEmojiMart,
  unmountEmojiMart
};
