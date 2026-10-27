'use strict';

function createDOMAdapter() {
  function setField(el, value) {
    if (el.isContentEditable) el.textContent = value;
    else {
      const win = el.ownerDocument.defaultView;
      const proto = el.localName === 'textarea' ? win.HTMLTextAreaElement?.prototype : win.HTMLInputElement?.prototype;
      const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    const EventClass = el.ownerDocument.defaultView.Event;
    el.dispatchEvent(new EventClass('input', { bubbles: true }));
    el.dispatchEvent(new EventClass('change', { bubbles: true }));
    el.dispatchEvent(new EventClass('keyup', { bubbles: true }));
    el.dispatchEvent(new EventClass('blur', { bubbles: false }));
  }
  return { setField };
}
module.exports = createDOMAdapter;
