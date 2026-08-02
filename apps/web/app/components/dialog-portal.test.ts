import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isolateDialogBackground } from './dialog-background-isolation';

const componentUrl = new URL('./app-router-client.tsx', import.meta.url);

function functionSource(source: string, name: string, nextName: string) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('workbench dialog viewport ownership', () => {
  test.each([
    ['ActionSheet', 'ConfirmDialog'],
    ['ConfirmDialog', 'SectionTitle'],
  ])('%s portals its backdrop outside the workbench scroll container', async (name, nextName) => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const dialog = functionSource(component, name, nextName);

    expect(dialog).toContain('const portalHost = useBodyPortalHost();');
    expect(dialog).toMatch(
      /return portalHost\s*\?\s*createPortal\([\s\S]*?className="modal-backdrop(?: centered)?"[\s\S]*?,\s*portalHost,?\s*\)\s*:\s*null;/,
    );
  });

  test('starts focus management after the portal content mounts', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const focusHook = functionSource(component, 'useDialogFocus', 'ActionSheet');

    expect(focusHook).toContain('function useDialogFocus(onClose: () => void, enabled: boolean)');
    expect(focusHook).toMatch(/useEffect\([\s\S]*?, \[enabled\]\);/);
  });
});

describe('nested dialog background isolation', () => {
  test('closing a child restores the parent isolation until the parent closes', () => {
    class FakeElement {
      inert = false;
      private attributes = new Map<string, string>();

      getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
      }

      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }

      removeAttribute(name: string) {
        this.attributes.delete(name);
      }
    }

    const background = new FakeElement();
    const parentBackdrop = new FakeElement();
    const restoreParent = isolateDialogBackground([background]);

    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');

    const restoreChild = isolateDialogBackground([
      background,
      parentBackdrop,
    ]);
    restoreChild();

    expect(background.inert).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(parentBackdrop.inert).toBe(false);
    expect(parentBackdrop.getAttribute('aria-hidden')).toBeNull();

    restoreParent();
    expect(background.inert).toBe(false);
    expect(background.getAttribute('aria-hidden')).toBeNull();
  });
});
