(() => {
  // Minimal inline-edit bridge for DOCUMENT artifacts.
  //
  // Decks carry deck-shell.js, which implements the host's Edit button
  // (enable/disable/save + dirty tracking over postMessage). Documents
  // have no shell, so the Edit button did nothing. This tiny script
  // mirrors that same message contract for the .doc-page flow.
  //
  // It is injected by the preview route only — never baked into the
  // saved file — so on save we strip ourselves out and the document
  // stays clean. The next preview re-injects us.
  const self = document.currentScript;
  const page = () => document.querySelector('.doc-page') || document.body;
  let editMode = false;
  let dirtyNotified = false;

  const onAnyEdit = () => {
    if (!editMode || dirtyNotified) return;
    dirtyNotified = true;
    window.parent.postMessage({ type: 'workpod-edit-dirty' }, '*');
  };

  const ensureStyle = () => {
    if (document.getElementById('workpod-edit-style')) return;
    const style = document.createElement('style');
    style.id = 'workpod-edit-style';
    style.textContent = `
      .doc-page[contenteditable="true"] { outline: none; }
      .doc-page[contenteditable="true"] :is(h1,h2,h3,p,li,blockquote,td,th,.lede,.eyebrow,.callout,.alert):hover {
        outline: 1px dashed rgba(0, 113, 227, 0.30); outline-offset: 3px; border-radius: 3px; cursor: text;
      }
      .doc-page[contenteditable="true"] :is(h1,h2,h3,p,li,blockquote,td,th,.lede,.eyebrow,.callout,.alert):focus {
        outline: 2px solid rgba(0, 113, 227, 0.55); background: rgba(0, 113, 227, 0.05);
      }
    `;
    document.head.appendChild(style);
  };

  const enableEditMode = () => {
    if (editMode) return;
    editMode = true;
    dirtyNotified = false;
    const p = page();
    p.setAttribute('contenteditable', 'true');
    p.setAttribute('spellcheck', 'true');
    ensureStyle();
    document.addEventListener('input', onAnyEdit, true);
  };

  const disableEditMode = () => {
    if (!editMode) return;
    editMode = false;
    dirtyNotified = false;
    document.removeEventListener('input', onAnyEdit, true);
    const p = page();
    p.removeAttribute('contenteditable');
    p.removeAttribute('spellcheck');
  };

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'workpod-edit-enable')  enableEditMode();
    if (e.data.type === 'workpod-edit-disable') disableEditMode();
    if (e.data.type === 'workpod-edit-save') {
      // Strip the editing scaffolding AND this injected script so the
      // serialized document is exactly what the agent would have
      // written. The window listener survives removing the element.
      const wasEditing = editMode;
      disableEditMode();
      const styleNode = document.getElementById('workpod-edit-style');
      if (styleNode) styleNode.remove();
      if (self && self.parentNode) self.parentNode.removeChild(self);
      const html = '<!doctype html>\n' + document.documentElement.outerHTML;
      if (wasEditing) enableEditMode();
      window.parent.postMessage({ type: 'workpod-edit-saved', html }, '*');
    }
  });
})();
