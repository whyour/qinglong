const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A minimal DOM; all navigation, requests and validation execute the shipped JS.
class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.isConnected = true;
    this.value = '';
    this.disabled = false;
    this.open = false;
  }
  set textContent(value) {
    this.text = value;
    this.replaceChildren();
  }
  get textContent() {
    return (this.text || '') + this.children.map((x) => x.textContent).join('');
  }
  append(...children) {
    for (const child of children) {
      if (child.tag === 'fragment') this.append(...child.children);
      else {
        child.parent = this;
        this.children.push(child);
      }
    }
  }
  detach() {
    this.isConnected = false;
    this.children.forEach((child) => child.detach());
  }
  replaceChildren(...children) {
    this.children.forEach((child) => child.detach());
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
  querySelector() {
    return new Element();
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === child.tag || selector === `.${child.className}`
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  focus() {
    this.focusCount = (this.focusCount || 0) + 1;
  }
  select() {
    this.selectCount = (this.selectCount || 0) + 1;
  }
  reset() {}
  showModal() {
    this.open = true;
    this.openCount = (this.openCount || 0) + 1;
  }
  close() {
    this.open = false;
  }
}

function fixture(view, response) {
  const nodes = new Map();
  const calls = [];
  const context = vm.createContext({
    TextDecoder,
    TextEncoder,
    crypto: require('node:crypto').webcrypto,
    Uint8Array,
    URLSearchParams,
    Intl,
    console,
    window: {
      atob,
      btoa,
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
      },
      querySelector: () => new Element(),
      createElement: (tag) => new Element(tag),
      createDocumentFragment: () => new Element('fragment'),
      addEventListener() {},
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = await response(url, calls.length, options);
      return {
        ok: !body.httpStatus,
        status: body.httpStatus || 200,
        json: body.json || (async () => body),
        headers: { get: () => null },
      };
    },
  });
  const source = fs.readFileSync(
    path.join(__dirname, '../../assets/console/console.js'),
    'utf8',
  );
  assert.ok(source.endsWith('})();\n'));
  vm.runInContext(
    source.slice(0, -6) +
      'globalThis.client = { state, nodes, refresh, selectTask, selectTrigger, disconnect, connect, api, loadSecretCatalog, beginTaskAuthoring, completeTaskMutation, saveTaskDraft, saveTriggerDraft, saveSecretDraft, startTask, cancelRun };})();',
    context,
  );
  Object.assign(context.client.state, {
    token: 'memory-only-test-token',
    project: 'default',
    view,
  });
  return { ...context.client, calls };
}

module.exports = { fixture };
