import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { useGlobalSessionStatusStore, replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { getSyncChildStores } from '@/sync/sync-refs';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';

const directory = '/repo';
const parentId = 'parent';
const childId = 'child';

const parent: Session = {
  id: parentId, projectID: 'project', directory, title: 'Parent', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
};

const child: Session = {
  id: childId, parentID: parentId, projectID: 'project', directory, title: 'Child', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 1 },
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

describe('WorkStatusSubagentsSection live activity', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  const sdk = OpenCode.make({ baseUrl: 'http://work-status.test', fetch: () => new Promise<Response>(() => undefined) });

  const store = () => {
    const childStore = getSyncChildStores().getChild(directory);
    if (!childStore) throw new Error('Expected mounted directory store');
    return childStore;
  };

  beforeEach(async () => {
    dom = installDom();
    root = createRoot(dom.container);
    useUIStore.setState({ workStatusExpandedSections: {}, workStatusHiddenSections: [], workStatusHiddenSectionsExplicit: false });
    replaceGlobalSessionStatusById(new Map());
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><WorkStatusSubagentsSection sessionId={parentId} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
    await act(async () => store().setState({ session: [parent, child], session_status: {} }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    replaceGlobalSessionStatusById(new Map());
    useGlobalSessionStatusStore.setState({ observedById: new Map() });
    dom.restore();
  });

  test('uses global busy and retry status when the directory status is absent, then shows done after settlement', async () => {
    await act(async () => replaceGlobalSessionStatusById(new Map([
      [childId, { status: { type: 'busy' }, directory }],
    ])));
    expect(dom.container.textContent).toContain('is working');
    expect(dom.container.textContent).not.toContain('Done');

    await act(async () => replaceGlobalSessionStatusById(new Map([
      [childId, { status: { type: 'retry', attempt: 1, message: 'retrying', next: 0 }, directory }],
    ])));
    expect(dom.container.textContent).toContain('is working');
    expect(dom.container.textContent).not.toContain('Done');

    await act(async () => replaceGlobalSessionStatusById(new Map()));
    expect(dom.container.textContent).toContain('Done');

    await act(async () => store().setState({ session_status: { [childId]: { type: 'busy' } } }));
    expect(dom.container.textContent).toContain('is working');
  });
});
